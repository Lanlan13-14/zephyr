plugins {
    id("zephyr.android.compose")
}

android {
    namespace = "one.zephyr.mobile.feature.filesync"
}

dependencies {
    implementation(project(":core-ui"))
    implementation(project(":core-sync"))
    implementation(libs.kotlinx.coroutines.android)
    implementation(project(":protocol-zft2"))
    implementation(libs.androidx.documentfile)
    implementation(libs.androidx.work.runtime.ktx)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.turbine)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.test.junit)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}
