plugins {
    `kotlin-dsl`
}

dependencies {
    implementation("com.android.tools.build:gradle:8.7.3")
    implementation("org.jetbrains.kotlin:kotlin-gradle-plugin:2.0.21")
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
