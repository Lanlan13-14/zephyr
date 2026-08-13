plugins {
    id("zephyr.android.library")
}

android {
    namespace = "one.zephyr.mobile.protocol.vnc"
}

dependencies {
    api(project(":core-model"))
    implementation(libs.kotlinx.coroutines.android)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
