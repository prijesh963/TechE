// The IntelliJ Platform shell: a startup notification and a Tools-menu
// action, both just calling into :core's McpSetupService. Depends on
// :core for every real decision and adds only what only the IDE can
// provide — the notification, the menu entry, PathManager's own paths.
//
// UNVERIFIED IN THIS SANDBOX, same reason and same shape as
// credit-optimizer-plugin's own :plugin module: `intellijPlatform {
// create("IC", ...) }` resolves the actual IDE distribution from
// JetBrains' own hosts (cache-redirector.jetbrains.com and friends), and
// this environment's egress policy returns 403 for all of them (confirmed
// directly with curl, not assumed). :core has no such dependency and is
// fully built and tested above; this module's real verification is real
// CI (see .github/workflows/intellij-plugin-ci.yml) on a runner with no
// such restriction.

plugins {
    kotlin("jvm")
    id("org.jetbrains.intellij.platform") version "2.1.0"
}

group = "com.copilotarchitect"
version = "0.1.0"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
        // instrumentationTools()'s :instrumentCode (NotNull assertions etc.) needs a
        // Java compiler dependency resolved from here — ported from
        // credit-optimizer-plugin/plugin/build.gradle.kts, which hit "No Java
        // Compiler dependency found" without it.
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
        name = "Copilot Architect"
        version = project.version.toString()
        ideaVersion {
            sinceBuild = "242"
            untilBuild = provider { null } // see credit-optimizer-plugin's own build.gradle.kts for why this must be explicit
        }
    }

    pluginVerification {
        ides {
            ide("IC", "2024.2.3")
        }
    }
}

// The CLI bundle (`npm run build && npm run bundle:cli` from the repo
// root) is generated output, not checked in — same reason dist-cli/ is
// gitignored there. Copied into a build-time resources directory rather
// than src/main/resources so nothing generated ever needs a human to
// remember not to commit it.
val cliBundleDir = layout.projectDirectory.dir("../../dist-cli")
val generatedResourcesDir = layout.buildDirectory.dir("generated-resources/copilot-architect")

val copyCliBundle by tasks.registering(Copy::class) {
    description = "Copies the bundled CLI (npm run bundle:cli at the repo root) into plugin resources."

    doFirst {
        if (!cliBundleDir.file("cli.mjs").asFile.exists()) {
            throw GradleException(
                "dist-cli/cli.mjs not found. Run `npm run build && npm run bundle:cli` " +
                    "from the repository root before building this plugin."
            )
        }
    }

    from(cliBundleDir)
    into(generatedResourcesDir.map { it.dir("copilot-architect") })
}

sourceSets {
    main {
        resources.srcDir(generatedResourcesDir)
    }
}

tasks.named("processResources") {
    dependsOn(copyCliBundle)
}
