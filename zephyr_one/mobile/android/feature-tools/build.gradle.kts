plugins {
    id("zephyr.android.compose")
}

android {
    namespace = "one.zephyr.mobile.feature.tools"
}

dependencies {
    implementation(project(":core-ui"))
    implementation(project(":core-sync"))
    implementation(project(":core-data"))
    implementation(project(":core-security"))
    implementation(project(":core-network"))
    implementation(project(":feature-file-sync"))
    implementation(libs.kotlinx.coroutines.android)
    implementation(project(":protocol-ssh")) // batch execution targets SSH only
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.turbine)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.test.junit)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}
