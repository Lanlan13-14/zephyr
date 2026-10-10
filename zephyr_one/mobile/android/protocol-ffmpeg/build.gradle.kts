plugins {
    id("zephyr.android.library")
}

val ffmpegAndroidRoot = providers.gradleProperty("zephyr.ffmpeg.androidRoot")
    .orElse(providers.environmentVariable("ZEPHYR_ANDROID_FFMPEG_ROOT"))
    .orNull

android {
    namespace = "one.zephyr.mobile.protocol.ffmpeg"

    if (ffmpegAndroidRoot != null) {
        defaultConfig {
            ndk {
                abiFilters += listOf("arm64-v8a")
            }
            externalNativeBuild {
                cmake {
                    arguments += "-DZEPHYR_FFMPEG_ANDROID_ROOT=$ffmpegAndroidRoot"
                }
            }
        }
        externalNativeBuild {
            cmake {
                path = file("src/main/cpp/CMakeLists.txt")
                version = "3.22.1"
            }
        }
        val packagedCli = layout.buildDirectory.dir("ffmpeg-cli")
        sourceSets.getByName("main").jniLibs.srcDir(packagedCli)
        val packageCli = tasks.register<Copy>("packageFfmpegCli") {
            from("$ffmpegAndroidRoot/arm64-v8a/bin/ffmpeg")
            into(packagedCli.map { it.dir("arm64-v8a") })
            rename { "libffmpegexec.so" }
            doLast {
                val shipped = packagedCli.get().file("arm64-v8a/libffmpegexec.so").asFile
                check(shipped.isFile && shipped.length() > 1024L) {
                    "FFmpeg CLI was not packaged as libffmpegexec.so"
                }
            }
        }
        tasks.named("preBuild").configure { dependsOn(packageCli) }
    }
}

dependencies {
    implementation(libs.kotlinx.coroutines.android)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
