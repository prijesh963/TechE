package com.copilotarchitect.core

import java.io.File

/**
 * Finds a usable Node.js binary on this machine.
 *
 * IntelliJ is a JVM application with no Node runtime of its own — unlike
 * the VS Code extension, which spawns its bundled CLI with
 * `process.execPath` (the host's own Node binary) and never needs to look
 * for one. Here Node has to actually be findable on disk, and PATH as seen
 * by a GUI-launched IDE process is not always the same PATH a terminal
 * shell has (a real, common gap on macOS in particular) — so a short list
 * of common install locations is checked too, not just PATH.
 */
object NodeLocator {
    private val extraDirs: List<String> by lazy {
        val home = System.getProperty("user.home") ?: ""
        listOf(
            "/usr/local/bin",
            "/opt/homebrew/bin",
            "/usr/bin",
            "$home/.nvm/current/bin",
            "$home/.volta/bin"
        )
    }

    /** The Node binary to look for, per platform — never both on one OS. */
    private fun candidateName(): String = if (isWindows()) "node.exe" else "node"

    /** The first executable `node`/`node.exe` found across PATH, then the fallback list. */
    fun find(): File? {
        val name = candidateName()

        for (dir in pathDirs() + extraDirs) {
            val candidate = File(dir, name)
            if (candidate.isFile && candidate.canExecute()) {
                return candidate
            }
        }

        return null
    }

    private fun pathDirs(): List<String> =
        (System.getenv("PATH") ?: "")
            .split(File.pathSeparator)
            .filter { it.isNotBlank() }

    private fun isWindows(): Boolean =
        System.getProperty("os.name")?.lowercase()?.contains("win") == true
}
