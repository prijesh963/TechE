// Root build file. Each module configures itself; nothing shared here yet —
// :core has no IntelliJ Platform dependency at all (plain Kotlin/JVM), and
// :plugin's IntelliJ Platform Gradle plugin setup is isolated to its own
// build file so a change to one module's toolchain can't leak into the
// other's.
//
// The Kotlin plugin version itself is the one thing that can't be isolated
// per-module: Gradle resolves a single classpath per plugin ID for the
// whole build. Bumped from 2.0.21 to 2.2.0 for :mcp-server's sake - the
// MCP Kotlin SDK's own dependencies (kotlinx-io, kotlinx-serialization) are
// compiled with newer Kotlin metadata than 2.0.21 can read at all (a real
// compiler error, not a style choice). :core keeps passing under 2.2.0
// (verified locally); :plugin's compatibility with it is CI-only, same as
// every other :plugin claim in this project.

plugins {
    kotlin("jvm") version "2.2.0" apply false
}
