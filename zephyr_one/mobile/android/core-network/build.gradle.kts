plugins {
    id("zephyr.android.library")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "one.zephyr.mobile.network"
}

dependencies {
    api(project(":core-model"))
    api(project(":core-security"))
    api(libs.okhttp)
    implementation(libs.okhttp.logging)
    implementation(libs.kotlinx.coroutines.android)
    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.kotlinx.coroutines.test)
}
