plugins {
    id("zephyr.android.compose")
}

android {
    namespace = "one.zephyr.mobile.ui"
}

dependencies {
    api(project(":core-model"))
    api(platform(libs.androidx.compose.bom))
    api(libs.androidx.compose.ui)
    api(libs.androidx.compose.ui.graphics)
    api(libs.androidx.compose.foundation)
    api(libs.androidx.compose.ui.tooling.preview)
    api(libs.androidx.lifecycle.viewmodel.compose)
    api(libs.androidx.lifecycle.runtime.compose)
    // viewModelScope lives here in lifecycle 2.8.x. Exposed as api because every feature module's
    // ViewModel launches into it, and a transitive-only dependency would break their compilation.
    api(libs.androidx.lifecycle.viewmodel.ktx)
    api(libs.androidx.navigation.compose)
    // PredictiveBack.kt names kotlinx.coroutines.CancellationException directly, so this
    // module must declare coroutines rather than inherit whatever Compose happens to
    // expose transitively.
    implementation(libs.kotlinx.coroutines.android)
    // PredictiveBackHandler lives here. DEVELOPMENT.md 2.3 requires the system back progress to be
    // the only gesture source of truth, so the visual is custom but the signal is not.
    api(libs.androidx.activity.compose)
    debugImplementation(libs.androidx.compose.ui.tooling)
    testImplementation(libs.junit)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    androidTestImplementation(libs.androidx.test.junit)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}
