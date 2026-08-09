import com.android.build.gradle.LibraryExtension
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.kotlin.dsl.configure
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinAndroidProjectExtension

/**
 * Shared Android library configuration so every Zephyr One module compiles against one
 * SDK/JVM matrix. Keeping this in buildSrc stops per-module drift in minSdk or JVM target.
 */
class ZephyrAndroidLibrary : Plugin<Project> {
    override fun apply(target: Project) {
        with(target) {
            pluginManager.apply("com.android.library")
            pluginManager.apply("org.jetbrains.kotlin.android")

            extensions.configure<LibraryExtension> {
                compileSdk = ZephyrBuild.COMPILE_SDK
                defaultConfig {
                    minSdk = ZephyrBuild.MIN_SDK
                    consumerProguardFiles("consumer-rules.pro")
                }
                compileOptions {
                    sourceCompatibility = ZephyrBuild.JAVA_VERSION
                    targetCompatibility = ZephyrBuild.JAVA_VERSION
                }
                buildFeatures {
                    buildConfig = false
                }
            }

            extensions.configure<KotlinAndroidProjectExtension> {
                compilerOptions {
                    jvmTarget.set(JvmTarget.JVM_17)
                    // Release builds must not ship a trust-all verifier or debug-only escape hatch.
                    freeCompilerArgs.add("-Xjvm-default=all")
                }
            }
        }
    }
}
