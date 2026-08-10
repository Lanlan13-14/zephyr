plugins {
    id("zephyr.android.library")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "one.zephyr.mobile.sync"
}

dependencies {
    api(project(":core-data"))
    api(project(":core-network"))
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.kotlinx.coroutines.android)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.turbine)
}
