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
        // versionName stays "1.0.0": the release workflow asserts it, and the pre
        // number lives only in the tag name. PRE_LABEL carries that number into
        // the app so the diagnostics page can show "1.0.0pre97" instead of "1.0.0".
        val preLabel = (project.findProperty("zephyr.preLabel") as? String).orEmpty().trim()
        buildConfigField("String", "PRE_LABEL", "\"$preLabel\"")
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        // Declared here as well as in release so both variants resolve the manifest
        // placeholder. Debug inherits false rather than defaulting to permissive: a debug
        // build talking to a plain-http server is exactly how a cleartext regression reaches
        // release unnoticed.
        manifestPlaceholders["usesCleartextTraffic"] = "false"

        // The APK is arm64-only: FreeRDP/FFmpeg JNI are built for arm64-v8a
        // and libvlc-all otherwise ships x86/x86_64/armeabi-v7a copies that
        // tripled the APK to ~110 MiB.
        ndk {
            abiFilters += listOf("arm64-v8a")
        }
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
        create("prerelease") {
            initWith(getByName("release"))
            // Keep the package identity used by pre1-pre6 so this APK updates in place, while
            // compiling it like release: non-debuggable, R8-optimized and resource-shrunk.
            applicationIdSuffix = ".debug"
            matchingFallbacks.add("release")
            signingConfig = signingConfigs.getByName("prerelease")
            isDebuggable = false
            isMinifyEnabled = true
            isShrinkResources = true
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
        jniLibs.useLegacyPackaging = true
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }

    // libvlc 3.6.5 and the FFmpeg CLI both ship libc++_shared.so. A jniLibs source
    // lost the duplicate merge, and a doLast on the merge task never ran because
    // that task was FROM-CACHE. pre121 and the #277 CI APK both still shipped
    // FFmpeg's 1.2 MB copy, and libvlcjni's JNI_OnLoad returns JNI_ERR against it.
    // This task runs after strip and before packaging, and it is never cached.
    val vlcLibcxx = configurations.create("vlcLibcxx")
    val replaceVlcLibcxx = tasks.register("replaceVlcLibcxx") {
        outputs.upToDateWhen { false }
        dependsOn("mergePrereleaseNativeLibs")
        doLast {
            val merged = layout.buildDirectory.get().asFile
            val targets = merged.walkTopDown().filter { it.name == "libc++_shared.so" && "arm64-v8a" in it.path }.toList()
            val aar = vlcLibcxx.files.single { it.name.startsWith("libvlc-all-") && it.name.endsWith(".aar") }
            val extracted = layout.buildDirectory.file("vlc-libcxx/libc++_shared.so").get().asFile
            extracted.parentFile.mkdirs()
            zipTree(aar).matching { include("jni/arm64-v8a/libc++_shared.so") }.singleFile.copyTo(extracted, overwrite = true)
            check(extracted.length() > 4L * 1024 * 1024) { "LibVLC libc++ is ${extracted.length()} bytes" }
            check(targets.isNotEmpty()) { "merge produced no arm64 libc++_shared.so under ${merged}" }
            targets.forEach { target ->
                extracted.copyTo(target, overwrite = true)
                logger.lifecycle("replaced ${target} (${target.length()} bytes)")
            }
        }
    }
    tasks.matching { it.name == "stripPrereleaseDebugSymbols" || it.name == "packagePrerelease" }.configureEach {
        dependsOn(replaceVlcLibcxx)
    }
    tasks.named("mergePrereleaseNativeLibs").configure { outputs.upToDateWhen { false } }
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
    // Biometric 1.2.0-alpha05 still declares Fragment 1.2.5 transitively. That legacy
    // FragmentActivity rejects ActivityResultRegistry's high request codes, crashing every SAF
    // picker (SFTP upload/download, AI attachment, directory authorizer). Pin a compatible
    // Fragment implementation at the application boundary.
    implementation(libs.androidx.fragment)
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
    implementation(libs.androidx.compose.animation)
    debugImplementation(libs.androidx.compose.ui.tooling)

    add("vlcLibcxx", "org.videolan.android:libvlc-all:3.6.5")

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.turbine)
    androidTestImplementation(libs.androidx.test.junit)
    androidTestImplementation(libs.androidx.test.espresso.core)
    androidTestImplementation(platform(libs.androidx.compose.bom))
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
}
