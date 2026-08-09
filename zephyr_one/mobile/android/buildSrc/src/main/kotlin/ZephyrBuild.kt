import org.gradle.api.JavaVersion

/** Single source of truth for the Android build matrix. */
object ZephyrBuild {
    const val COMPILE_SDK = 35
    const val MIN_SDK = 26
    const val TARGET_SDK = 35
    const val APPLICATION_ID = "one.zephyr.mobile"
    const val VERSION_CODE = 1
    const val VERSION_NAME = "0.1.0"
    val JAVA_VERSION: JavaVersion = JavaVersion.VERSION_17
}
