// Root build file. Each module configures itself; nothing shared here yet.
//
// Split into :core and :plugin for the same reason credit-optimizer-plugin
// was: :core has no IntelliJ Platform dependency at all (plain Kotlin/JVM),
// so it is the piece this sandbox can actually build and test — every
// class in :plugin imports com.intellij.* APIs, which pulls in the
// IntelliJ Platform distribution that :plugin/build.gradle.kts documents
// as unreachable from here.

plugins {
    kotlin("jvm") version "2.0.21" apply false
}
