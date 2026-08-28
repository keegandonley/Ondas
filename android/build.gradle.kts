// Aliases only. No allprojects/subprojects block, no convention plugins, no buildSrc --
// two modules do not need a build-logic layer, and both sibling ports stayed flat for the
// same reason.
//
// NOTE the absence of org.jetbrains.kotlin.android: AGP 9 has built-in Kotlin support and
// applying that plugin is a HARD configuration failure ("no longer required for Kotlin
// support since AGP 9.0"). org.jetbrains.kotlin.jvm is still correct for :ondaskit.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.compose.compiler) apply false
}
