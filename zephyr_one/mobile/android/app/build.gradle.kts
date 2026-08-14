// Versionless ids: buildSrc puts AGP, the Kotlin Gradle plugin and its compose/serialization
// companions on the build script classpath, so a versioned request here cannot be resolved.
plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = ZephyrBuild.APPLICATION_ID
    compileSdk = ZephyrBuild.COMPILE_SDK

    // One committed PKCS12 for every machine. assembleDebug used to pick up
    // ~/.android/debug.keystore, which CI regenerates on every runner, so
    // successive pre-release APKs could not update each other.
    signingConfigs {
        create("prerelease") {
            storeFile = file("signing/zephyr-one-prerelease.p12")
            storePassword = "zephyr-one-prerelease"
            keyAlias = "zephyr-one"
            keyPassword = "zephyr-one-prerelease"
            storeType = "PKCS12"
        }
    }

    defaultConfig {
        applicationId = ZephyrBuild.APPLICATION_ID
        minSdk = ZephyrBuild.MIN_SDK
        targetSdk = ZephyrBuild.TARGET_SDK
        versionCode = ZephyrBuild.VERSION_CODE
        versionName = ZephyrBuild.VERSION_NAME
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // Declared here as well as in release so both variants resolve the manifest
        // placeholder. Debug inherits false rather than defaulting to permissive: a debug
        // build talking to a plain-http server is exactly how a cleartext regression reaches
        // release unnoticed.
        manifestPlaceholders["usesCleartextTraffic"] = "false"
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            signingConfig = signingConfigs.getByName("prerelease")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            signingConfig = signingConfigs.getByName("prerelease")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Release must not permit cleartext or a trust-all verifier.
            manifestPlaceholders["usesCleartextTraffic"] = "false"
        }
    }

    compileOptions {
        sourceCompatibility = ZephyrBuild.JAVA_VERSION
        targetCompatibility = ZephyrBuild.JAVA_VERSION
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(project(":core-contracts"))
    implementation(project(":core-model"))
    implementation(project(":core-security"))
    implementation(project(":core-network"))
    implementation(project(":core-data"))
    implementation(project(":core-ui"))
    implementation(project(":core-sync"))
    implementation(project(":protocol-zft2"))
    implementation(project(":protocol-telnet"))
    implementation(project(":protocol-ssh"))
    implementation(project(":protocol-rdp"))
    implementation(project(":protocol-vnc"))
    implementation(project(":feature-connections"))
    implementation(project(":feature-sessions"))
    implementation(project(":feature-remote"))
    implementation(project(":feature-notes"))
    implementation(project(":feature-file-sync"))
    implementation(project(":feature-tools"))
    implementation(project(":feature-ai"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.lifecycle.service)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.viewmodel.ktx)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.biometric)
    implementation(libs.androidx.documentfile)
    implementation(libs.androidx.security.crypto)
    implementation(libs.androidx.room.ktx)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    debugImplementation(libs.androidx.compose.ui.tooling)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.turbine)
    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.androidx.test.espresso.core)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}
