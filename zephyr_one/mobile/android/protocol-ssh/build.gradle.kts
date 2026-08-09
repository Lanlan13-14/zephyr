plugins {
    id("zephyr.android.library")
}

android {
    namespace = "one.zephyr.mobile.protocol.ssh"
}

dependencies {
    api(project(":core-model"))
    implementation(libs.kotlinx.coroutines.android)
    // Engine dependency is deliberately absent: ADR-002 in NATIVE_ENGINE_DECISIONS.md
    // must pick libssh2 vs SSHJ on real hardware before a version is pinned here.
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
