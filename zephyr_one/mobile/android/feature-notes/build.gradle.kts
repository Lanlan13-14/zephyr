plugins {
    id("zephyr.android.compose")
}

android {
    namespace = "one.zephyr.mobile.feature.notes"
}

dependencies {
    implementation(project(":core-ui"))
    implementation(project(":core-sync"))
    implementation(project(":core-data"))
    implementation(project(":protocol-ssh"))
    implementation(libs.kotlinx.coroutines.android)
    // Decode RAW on the device; never depend on a server ffmpeg/transcode endpoint.
    implementation("org.videolan.android:libvlc-all:3.6.5")
    implementation(libs.okhttp)
    implementation(libs.androidx.lifecycle.runtime.compose)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.turbine)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.test.junit)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}
