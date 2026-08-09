plugins {
    id("zephyr.android.library")
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "one.zephyr.mobile.security"
}

dependencies {
    api(project(":core-model"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.biometric)
    implementation(libs.kotlinx.coroutines.android)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
