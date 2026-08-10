plugins {
    id("org.jetbrains.kotlin.jvm")
}

// Pure JVM port of telnet-transport.js so the IAC state machine runs in unit tests.
dependencies {
    api(project(":core-contracts"))
    implementation(libs.kotlinx.coroutines.core)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}

kotlin {
    jvmToolchain(17)
}
