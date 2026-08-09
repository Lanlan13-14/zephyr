import com.android.build.gradle.LibraryExtension
import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.kotlin.dsl.configure

/** Android library plus Compose, for every module that owns UI. */
class ZephyrComposeLibrary : Plugin<Project> {
    override fun apply(target: Project) {
        with(target) {
            pluginManager.apply("zephyr.android.library")
            pluginManager.apply("org.jetbrains.kotlin.plugin.compose")

            extensions.configure<LibraryExtension> {
                buildFeatures {
                    compose = true
                }
            }
        }
    }
}
