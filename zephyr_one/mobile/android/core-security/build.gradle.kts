plugins {
    id("zephyr.android.library")
    id("org.jetbrains.kotlin.plugin.serialization")
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
