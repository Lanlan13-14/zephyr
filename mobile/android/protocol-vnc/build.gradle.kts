plugins {
    id("zephyr.android.library")
}

android {
    namespace = "one.zephyr.mobile.protocol.vnc"
}

dependencies {
    api(project(":core-model"))
    implementation(libs.kotlinx.coroutines.android)
    // ADR-005: RFB core selection is blocked on the GPL license audit.
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
