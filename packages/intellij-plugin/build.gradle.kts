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
version = "0.1.1"

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
            // Leaving this unset does NOT mean "no upper bound" the way it
            // reads — the Gradle IntelliJ Platform plugin silently derives
            // untilBuild as "<sinceBuild's branch>.*" (here, "242.*") when
            // it's omitted, capping real-world compatibility to the exact
            // 2024.2.x branch this was built against. A real install on
            // 2026.2 (build 262.x) was rejected with "requires build 242.*
            // or older" as a direct result — confirmed against an actual
            // IDE, not assumed from reading this file. Explicitly clearing
            // it removes the upper bound for real.
            untilBuild = provider { null }
        }
    }

    // :verifyPlugin needs to know which IDE(s) to verify against — without
    // this, CI failed with "No IDE resolved for verification", naming this
    // exact fix. Originally `recommended()`, which derives a version list
    // from `sinceBuild`/`untilBuild` above — that broke the moment
    // `untilBuild` became open-ended (see the untilBuild comment above):
    // with no upper bound to reason from, it picked "IC 2025.3", which
    // isn't actually a resolvable artifact anywhere (Maven Central or any
    // JetBrains mirror all 404 on it — confirmed by CI, not assumed). Pinned
    // explicitly instead, to the same version already used to compile
    // against below — guaranteed resolvable since the build already depends
    // on it — rather than trust an auto-derived guess a second time.
    pluginVerification {
        ides {
            ide("IC", "2024.2.3")
        }
    }
}

tasks {
    wrapper {
        gradleVersion = "8.10"
    }
}
