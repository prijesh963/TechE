// The core module: repo discovery, the lightweight Java parser, local
// storage, the free-path router and the usage log. Deliberately a plain
// Kotlin/JVM library with no IntelliJ Platform dependency, so it builds and
// tests fully in any environment (including this one, which cannot reach
// JetBrains' distribution hosts — see the repo root README) and so the
// logic that matters is never accidentally coupled to the IDE.

plugins {
    kotlin("jvm")
    id("java-library")
}

repositories {
    mavenCentral()
}

dependencies {
    // Standalone Java source parsing — no compiled classpath needed, so it
    // can read a sibling service repo on disk that is not open as an
    // IntelliJ project (see ADR-001 in the README: PSI vs. JavaParser).
    implementation("com.github.javaparser:javaparser-symbol-solver-core:3.26.2")

    // Local index storage and the usage log are both JSON files on disk.
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin:2.17.2")
    implementation("com.fasterxml.jackson.datatype:jackson-datatype-jsr310:2.17.2")

    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.0")
}

kotlin {
    jvmToolchain(21)
}

tasks.test {
    useJUnitPlatform()
}
