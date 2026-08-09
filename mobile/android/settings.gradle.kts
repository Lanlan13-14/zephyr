pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "zephyr-one"

include(":app")
include(":core-contracts")
include(":core-model")
include(":core-security")
include(":core-data")
include(":core-network")
include(":core-sync")
include(":core-ui")
include(":feature-connections")
include(":feature-sessions")
include(":feature-remote")
include(":feature-notes")
include(":feature-file-sync")
include(":feature-tools")
include(":feature-ai")
include(":protocol-zft2")
include(":protocol-telnet")
include(":protocol-ssh")
include(":protocol-rdp")
include(":protocol-vnc")
