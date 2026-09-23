// The IntelliJ Platform shell: tool window, quick-ask action, gutter line
// markers, settings. Depends on :core for every real decision (parsing,
// storage, routing, usage logging) and adds only what only the IDE can
// provide — UI, PSI for the currently-open file, the hotkey.
//
// UNVERIFIED IN THIS SANDBOX, same reason and same shape as every other
// IntelliJ plugin build attempted from here: `intellijPlatform { create("IC",
// ...) }` resolves the actual IDE distribution from JetBrains' own hosts
// (cache-redirector.jetbrains.com and friends), and this environment's
// egress policy returns 403 for all of them (confirmed directly with curl,
// not assumed). :core has no such dependency and is fully built and tested
// above; this module's real verification is real CI (see
// .github/workflows/plugin-ci.yml) on a runner with no such restriction.

plugins {
    kotlin("jvm")
    id("org.jetbrains.intellij.platform") version "2.1.0"
}

group = "com.creditoptimizer"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
        // instrumentationTools()'s :instrumentCode (NotNull assertions etc.) needs a Java
        // compiler dependency resolved from here — the intellij-main branch's plugin hit
        // "No Java Compiler dependency found" without this; ported the fix rather than
        // rediscover it.
        intellijDependencies()
    }
}

dependencies {
    implementation(project(":core"))

    intellijPlatform {
        create("IC", "2024.2.3")
        instrumentationTools()
        pluginVerifier()
    }
}

java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}

kotlin {
    jvmToolchain(21)
}

intellijPlatform {
    pluginConfiguration {
        name = "Credit Optimizer"
        version = project.version.toString()
        ideaVersion {
            sinceBuild = "242"
            untilBuild = provider { null } // see the intellij-main branch's build.gradle.kts for why this must be explicit
        }
    }

    pluginVerification {
        ides {
            ide("IC", "2024.2.3")
        }
    }
}
