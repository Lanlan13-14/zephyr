// AGP and the Kotlin Gradle plugin reach every project through the buildSrc script
// classpath, so they must not be re-declared with a version here: Gradle rejects a
// versioned request for a plugin that is already on the classpath. Only plugins that
// buildSrc does not supply are pinned in this block.
plugins {
    alias(libs.plugins.ksp) apply false
}
