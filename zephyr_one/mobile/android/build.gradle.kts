import org.gradle.api.tasks.testing.Test
import java.time.Duration

// AGP and the Kotlin Gradle plugin reach every project through the buildSrc script
// classpath, so they must not be re-declared with a version here: Gradle rejects a
// versioned request for a plugin that is already on the classpath. Only plugins that
// buildSrc does not supply are pinned in this block.
plugins {
    alias(libs.plugins.ksp) apply false
}

// CI opts into a hard deadline for every module's Test task. This is deliberately a project
// property rather than a local default: developers may debug interactively, while CI must never
// let a leaked coroutine or non-daemon test thread occupy a runner indefinitely.
providers.gradleProperty("zephyr.unitTestTimeoutSeconds").orNull?.let { raw ->
    val seconds = raw.toLongOrNull()?.takeIf { it > 0L }
        ?: throw GradleException("zephyr.unitTestTimeoutSeconds must be a positive integer")
    allprojects {
        tasks.withType<Test>().configureEach {
            failFast = true
            timeout.set(Duration.ofSeconds(seconds))
        }
    }
}
