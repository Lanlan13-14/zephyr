plugins {
    id("zephyr.android.library")
    id("org.jetbrains.kotlin.plugin.serialization")
    alias(libs.plugins.ksp)
}

android {
    namespace = "one.zephyr.mobile.data"

    defaultConfig {
        // Room exports schemas so migrations are reviewable instead of implicit.
        ksp {
            arg("room.schemaLocation", "$projectDir/schemas")
            arg("room.generateKotlin", "true")
        }
    }
}

dependencies {
    api(project(":core-model"))
    api(project(":core-security"))
    api(libs.androidx.room.runtime)
    implementation(libs.androidx.room.ktx)
    implementation(libs.androidx.sqlite)
    implementation(libs.sqlcipher.android)
    ksp(libs.androidx.room.compiler)
    implementation(libs.kotlinx.coroutines.android)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    androidTestImplementation(libs.androidx.room.testing)
    androidTestImplementation(libs.androidx.test.junit)
}
