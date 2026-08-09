plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

// Pure JVM: the domain model holds no Android types, so sync/field-mask/conflict logic built on
// it can be tested against contracts/generated/*.json without an emulator. Device-local URIs are
// carried as Strings for exactly this reason.
dependencies {
    api(project(":core-contracts"))
    api(libs.kotlinx.serialization.json)
    testImplementation(libs.junit)
}

kotlin {
    jvmToolchain(17)
}
