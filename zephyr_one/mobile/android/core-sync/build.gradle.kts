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
    // RoomSyncLocalStore names androidx.room.withTransaction directly. core-data api-exposes
    // room-runtime but keeps room-ktx as `implementation`, so the coroutine transaction
    // extension does not reach this module transitively and has to be declared here.
    implementation(libs.androidx.room.ktx)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.kotlinx.coroutines.android)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.turbine)
}
