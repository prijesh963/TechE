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
        // `:instrumentCode` (NotNull assertions etc.) needs a Java compiler
        // dependency it resolves from here — CI failed with "No Java
        // Compiler dependency found" without this, naming this exact fix.
        intellijDependencies()
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

        // Pairs with `intellijDependencies()` above — the actual Java
        // Compiler artifact `:instrumentCode` needs.
        instrumentationTools()

        // `build`'s `check` dependency pulls in `:verifyPlugin` (as does
        // this workflow's own separate `verifyPlugin` step) — without this,
        // CI failed with "No IntelliJ Plugin Verifier executable found",
        // naming this exact fix.
        pluginVerifier()
    }
}

// IntelliJ Platform 2024.2 (sinceBuild "242" below) moved its own runtime to
// JBR 21 — `verifyPluginProjectConfiguration` flagged 17 here as mismatched
// against the "2024.2.3" IDE version created above (CI's own findings, not
// assumed ahead of time).
java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}

kotlin {
    jvmToolchain(21)
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
