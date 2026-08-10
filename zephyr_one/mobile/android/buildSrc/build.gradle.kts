plugins {
    `kotlin-dsl`
}

dependencies {
    // Everything declared here lands on the build script classpath of every project in this
    // build, which is why the modules apply the matching plugin ids without a version.
    implementation("com.android.tools.build:gradle:8.7.3")
    implementation("org.jetbrains.kotlin:kotlin-gradle-plugin:2.0.21")
    // ZephyrComposeLibrary applies org.jetbrains.kotlin.plugin.compose by id, and the modules
    // apply org.jetbrains.kotlin.plugin.serialization the same way. Neither id is served by the
    // kotlin-gradle-plugin jar itself, so both are pulled in here through their plugin markers
    // at the same Kotlin version. Marker coordinates keep this tied to the published plugin id
    // rather than to an implementation artifact name.
    implementation("org.jetbrains.kotlin.plugin.compose:org.jetbrains.kotlin.plugin.compose.gradle.plugin:2.0.21")
    implementation("org.jetbrains.kotlin.plugin.serialization:org.jetbrains.kotlin.plugin.serialization.gradle.plugin:2.0.21")
}

gradlePlugin {
    plugins {
        register("zephyrAndroidLibrary") {
            id = "zephyr.android.library"
            implementationClass = "ZephyrAndroidLibrary"
        }
        register("zephyrComposeLibrary") {
            id = "zephyr.android.compose"
            implementationClass = "ZephyrComposeLibrary"
        }
    }
}
