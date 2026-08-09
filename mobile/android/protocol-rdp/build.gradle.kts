plugins {
    id("zephyr.android.library")
}

android {
    namespace = "one.zephyr.mobile.protocol.rdp"
}

dependencies {
    api(project(":core-model"))
    implementation(libs.kotlinx.coroutines.android)
    // ADR-004: FreeRDP core is reused through the existing C shim in
    // zephyr_one/native/zephyr-one-rdp/. The Android Surface binding is the open M0 item.
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
