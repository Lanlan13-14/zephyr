plugins {
    id("zephyr.android.library")
}

val freeRdpAndroidRoot = providers.gradleProperty("zephyr.rdp.freerdpAndroidRoot")
    .orElse(providers.environmentVariable("ZEPHYR_ANDROID_FREERDP_ROOT"))
    .orNull

android {
    namespace = "one.zephyr.mobile.protocol.rdp"

    if (freeRdpAndroidRoot != null) {
        defaultConfig {
            externalNativeBuild {
                cmake {
                    arguments += "-DZEPHYR_FREERDP_ANDROID_ROOT=$freeRdpAndroidRoot"
                }
            }
        }
        externalNativeBuild {
            cmake {
                path = file("src/main/cpp/CMakeLists.txt")
                version = "3.22.1"
            }
        }
    }
}

dependencies {
    api(project(":core-model"))
    implementation(libs.kotlinx.coroutines.android)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
