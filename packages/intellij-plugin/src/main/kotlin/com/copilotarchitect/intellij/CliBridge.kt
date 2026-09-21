package com.copilotarchitect.intellij

import com.intellij.openapi.diagnostic.Logger
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * The Core Rule this whole product follows — "a shell calls the CLI/core/MCP
 * services, it never owns the logic itself" — for a shell that cannot import
 * TypeScript at all. Every command this plugin runs is spawned as the same
 * bundled CLI the VS Code extension spawns; nothing in this plugin
 * re-implements repo intelligence.
 *
 * PHASE 1 LIMITATION: the CLI entry point is resolved from the
 * `COPILOT_ARCHITECT_CLI` environment variable (an absolute path to a built
 * `index.js`) or falls back to a relative dev-checkout path. Packaging the
 * built CLI inside this plugin's own distribution — the way the VS Code
 * `.vsix` bundles `cli.mjs` — is Phase 2 work; see
 * docs/KNOWN_LIMITATIONS.md.
 */
object CliBridge {
    private val log = Logger.getInstance(CliBridge::class.java)
    private val timeoutSeconds: Long = 60

    fun run(workspaceRoot: String, vararg args: String): CliResult {
        val (executable, baseArgs) = resolveCli()
        val command = listOf(executable) + baseArgs + args.toList()

        return try {
            val process = ProcessBuilder(command)
                .directory(File(workspaceRoot))
                .start()

            val stdout = process.inputStream.bufferedReader().readText()
            val stderr = process.errorStream.bufferedReader().readText()
            val finished = process.waitFor(timeoutSeconds, TimeUnit.SECONDS)

            if (!finished) {
                process.destroyForcibly()
                return CliResult(
                    exitCode = -1,
                    stdout = "",
                    stderr = "CLI command timed out after ${timeoutSeconds}s: ${command.joinToString(" ")}"
                )
            }

            CliResult(exitCode = process.exitValue(), stdout = stdout, stderr = stderr)
        } catch (error: Exception) {
            log.warn("Failed to run Copilot Architect CLI: ${command.joinToString(" ")}", error)
            CliResult(
                exitCode = -1,
                stdout = "",
                stderr = error.message ?: "Unknown error launching the Copilot Architect CLI"
            )
        }
    }

    private fun resolveCli(): Pair<String, List<String>> {
        val bundledEntry = System.getenv("COPILOT_ARCHITECT_CLI")
        if (bundledEntry != null && File(bundledEntry).exists()) {
            return "node" to listOf(bundledEntry)
        }
        // Dev-checkout fallback only — see the Phase 1 limitation above.
        return "node" to listOf("packages/cli/dist/index.js")
    }
}

data class CliResult(val exitCode: Int, val stdout: String, val stderr: String)
