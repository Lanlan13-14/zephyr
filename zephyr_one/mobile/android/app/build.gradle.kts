plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = ZephyrBuild.APPLICATION_ID
    compileSdk = ZephyrBuild.COMPILE_SDK

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
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
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
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.viewmodel.ktx)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.biometric)
    implementation(libs.androidx.documentfile)
    implementation(libs.androidx.security.crypto)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.material3)
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
