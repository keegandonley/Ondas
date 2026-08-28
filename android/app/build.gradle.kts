plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.compose.compiler)
    alias(libs.plugins.ksp)
}

android {
    namespace = "com.keegancodes.ondas"
    compileSdk = 37

    defaultConfig {
        applicationId = "com.keegancodes.ondas"
        // 30 matches both sibling ports. The ML Kit GenAI Prompt API's own floor is API 26,
        // so this is not the binding constraint -- Gemini Nano availability is, and that is
        // a per-device AICore question rather than an API-level one.
        minSdk = 30
        targetSdk = 37
        versionCode = 1
        // Deliberately BEHIND the Swift app's MARKETING_VERSION (1.0). The port is not at
        // parity yet and a matching version number would assert that it is. It moves to
        // match project.yml when the last spec in the port lands.
        versionName = "0.1.0"
    }

    signingConfigs {
        // INTERNAL TESTING ONLY. Signs the release build with the local debug key so a
        // minified, resource-shrunk build can actually be installed and exercised. This is
        // NOT an upload key and a Play submission needs a real one -- generate it with
        // keytool, keep it out of the repo, and read its password from a gitignored
        // keystore.properties or an env var.
        //
        // This is a hand-declared config, so unlike AGP's implicit `debug` config it does NOT
        // lazily generate the keystore. On a runner that has never built a debug variant,
        // invoking assembleRelease/bundleRelease directly fails with a missing-keystore error.
        // Dormant today (CI never builds release), and the fix when it stops being dormant is
        // a real upload key, not generating a debug one.
        create("internal") {
            storeFile = File(System.getProperty("user.home"), ".android/debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }

    buildTypes {
        release {
            signingConfig = signingConfigs.getByName("internal")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    // `buildConfig` is off by default in AGP 9.
    buildFeatures {
        compose = true
        buildConfig = true
    }

    // Robolectric needs the merged resources, manifest and asset table of the variant under
    // test; without this it boots into a sandbox with no resources and every theme/string
    // lookup fails.
    testOptions {
        unitTests {
            isIncludeAndroidResources = true
            isReturnDefaultValues = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}

dependencies {
    implementation(project(":ondaskit"))

    implementation(libs.room.runtime)
    ksp(libs.room.compiler)

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.graphics)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.compose.material.icons.core)
    implementation(libs.compose.material3.adaptive)
    implementation(libs.compose.material3.adaptive.layout)
    implementation(libs.compose.material3.adaptive.navigation)
    implementation(libs.compose.ui.tooling.preview)
    debugImplementation(libs.compose.ui.tooling)

    // Promoted from debugImplementation at spec #92: ChatEngine's MlKitModel now depends on it,
    // so it is part of the shipped app rather than only the src/debug capability probe.
    implementation(libs.mlkit.genai.prompt)

    testImplementation(libs.junit)
    testImplementation(libs.robolectric)
    testImplementation(libs.androidx.test.ext.junit)
    testImplementation(libs.androidx.test.core)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.turbine)
    testImplementation(libs.room.testing)
    testImplementation(platform(libs.compose.bom))
    testImplementation(libs.compose.ui.test.junit4)
    // A `debugImplementation`, NOT a `testImplementation`: Robolectric resolves the test
    // activity against the MERGED MANIFEST of the variant under test, so the manifest entry
    // has to be part of the debug variant rather than the test classpath.
    debugImplementation(libs.compose.ui.test.manifest)
}
