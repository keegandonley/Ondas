plugins {
    alias(libs.plugins.kotlin.jvm)
    // The OTLP span payload is serialized with kotlinx. The wire shape is asserted by the
    // ported TelemetryTests and by the shared fixture in contracts/otlp/, because it is a
    // contract with coding-stats rather than an internal detail.
    alias(libs.plugins.kotlin.serialization)
}

// The platform-free half of Ondas: models, Compaction, ConversationTitle, the capacity
// value types, and the telemetry encoder/exporter. NO Android dependency on purpose --
// see the comment in settings.gradle.kts.
kotlin {
    jvmToolchain(21)
    compilerOptions {
        // On for the same reason both sibling ports have it on: this module is where the
        // ported logic lives, and a deprecation warning here is usually a Swift construct
        // that was translated to the wrong Kotlin one.
        allWarningsAsErrors.set(true)
    }
}

// The OTLP wire fixture lives at the repo root in `contracts/`, and is read IN PLACE by both this
// suite and the Swift one. Copying it into the module would hide exactly the drift a shared
// fixture exists to catch, so the path is handed to the tests instead.
val contractsDir = rootProject.projectDir.parentFile.resolve("contracts")

tasks.withType<Test>().configureEach {
    systemProperty("ondas.contracts", contractsDir.absolutePath)
    // Declaring the directory as a task INPUT is what makes the contract real. Without it Gradle
    // considers the test task up-to-date when only a fixture changed, so editing the contract
    // re-runs nothing and the drift it exists to catch sails through green. Found by mutating a
    // fixture and watching the suite pass in 10s without executing.
    inputs.dir(contractsDir)
        .withPropertyName("otlpContracts")
        .withPathSensitivity(PathSensitivity.RELATIVE)
}

dependencies {
    api(libs.kotlinx.coroutines.core)
    api(libs.kotlinx.serialization.json)
    api(libs.kotlinx.datetime)
    // `api`, not `implementation`: OkHttp types are part of this module's PUBLIC surface --
    // `TelemetryConfig.endpoint` is an `HttpUrl` and `OtlpExporter` takes a `Call.Factory` (the
    // substitution seam, since OkHttp has no process-wide URLProtocol registry to intercept).
    // Consumers cannot call those APIs without the types on their compile classpath.
    api(libs.okhttp)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.turbine)
    testImplementation(libs.okhttp.mockwebserver)
}
