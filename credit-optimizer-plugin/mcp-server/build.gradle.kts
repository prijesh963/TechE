// The MCP server: exposes :core's index/router/handoff logic as MCP
// tools, so Copilot Chat can call into the local index directly (an
// explicit @mention was never coming back - GitHub Copilot Extensions
// were shut down entirely in November 2025 - and MCP is the modern
// replacement GitHub steered everyone toward instead). Plain Kotlin/JVM,
// same as :core: the SDK is an ordinary Maven Central library, not an
// IntelliJ Platform dependency, so this module builds, runs, and is
// exercisable directly in this sandbox - unlike :plugin.

plugins {
    // Gradle shares one classpath per plugin ID across the whole build, so this can't
    // be pinned separately from :core/:plugin - see root build.gradle.kts for why the
    // shared version had to move to 2.2.0.
    kotlin("jvm")
    application
}

repositories {
    mavenCentral()
}

dependencies {
    implementation(project(":core"))
    implementation("io.modelcontextprotocol:kotlin-sdk:0.8.3")

    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.0")
}

kotlin {
    jvmToolchain(21)
}

application {
    mainClass.set("com.creditoptimizer.mcp.MainKt")
}

tasks.test {
    useJUnitPlatform()
}
