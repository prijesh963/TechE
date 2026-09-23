// Root build file. Each module configures itself; nothing shared here yet —
// :core has no IntelliJ Platform dependency at all (plain Kotlin/JVM), and
// :plugin's IntelliJ Platform Gradle plugin setup is isolated to its own
// build file so a change to one module's toolchain can't leak into the
// other's.

plugins {
    kotlin("jvm") version "2.0.21" apply false
}
