plugins {
    id("zephyr.android.library")
}

android {
    namespace = "one.zephyr.mobile.protocol.ssh"
}

dependencies {
    api(project(":core-model"))
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.sshj)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
