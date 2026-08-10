plugins {
    id("org.jetbrains.kotlin.jvm")
}

// Pure JVM on purpose: protocol-zft2 and protocol-telnet are JVM modules and depend on the
// contracts, and a Gradle JVM module cannot consume an AAR. Keeping the contracts Android-free
// also lets every codec test run without an emulator.
dependencies {
    // Generated from mobile/contracts by `node mobile/tools/generate.mjs`.
    // Intentionally dependency-free so every layer can read the contracts.
}

kotlin {
    jvmToolchain(17)
}
