// Node discovery, the global MCP config merge, CLI resource extraction,
// and the orchestration over all three (McpSetupService) — every real
// decision this plugin makes, none of it depending on the IntelliJ
// Platform. Runs anywhere, including the sandbox this was developed in,
// which is why the actual logic lives here rather than in :plugin.

plugins {
    kotlin("jvm")
}

repositories {
    mavenCentral()
}

dependencies {
    implementation("com.google.code.gson:gson:2.11.0")

    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.0")
}

kotlin {
    jvmToolchain(21)
}

tasks.test {
    useJUnitPlatform()
}
