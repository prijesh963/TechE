// The IntelliJ edition of Copilot Architect. Unlike every other package in
// this monorepo, this one is Kotlin/Gradle, not TypeScript/npm — a real
// second toolchain, kept out of `tsc -b` and `npm test` entirely. It owns no
// repo intelligence of its own: every dashboard render and every command it
// runs goes through the same bundled CLI the VS Code extension spawns (see
// CliBridge.kt), the same Core Rule the rest of the product follows.

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.0.21"
    id("org.jetbrains.intellij.platform") version "2.1.0"
}

group = "com.copilotarchitect"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        create("IC", "2024.2.3")
        // `com.intellij.modules.platform` is a core platform module, not a
        // separately-packaged bundled plugin — it's already provided by the
        // `create("IC", ...)` platform artifact above and is declared the
        // normal way in plugin.xml's own <depends>. Requesting it here via
        // `bundledPlugin(...)` asks Gradle to resolve it as if it had its
        // own plugin JAR, which it does not: CI failed with "Could not find
        // bundled plugin with ID: 'com.intellij.modules.platform'" for
        // exactly this reason.
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    jvmToolchain(17)
}

intellijPlatform {
    pluginConfiguration {
        name = "Copilot Architect"
        version = project.version.toString()
        ideaVersion {
            sinceBuild = "242"
        }
    }
}

tasks {
    wrapper {
        gradleVersion = "8.10"
    }
}
