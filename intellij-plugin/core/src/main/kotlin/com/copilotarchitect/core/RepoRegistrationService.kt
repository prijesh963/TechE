package com.copilotarchitect.core

import java.io.File
import java.util.concurrent.TimeUnit

/** One repo to register: the name it gets in `workspace.json` and its path on disk. */
data class RepoRegistration(val name: String, val path: File)

sealed interface RepoRegistrationOutcome {
    data class Registered(val name: String) : RepoRegistrationOutcome
    data class Failed(val name: String, val reason: String) : RepoRegistrationOutcome
}

sealed interface RegisterReposResult {
    /** Node/extraction succeeded; per-repo outcomes may still individually fail. */
    data class Completed(val outcomes: List<RepoRegistrationOutcome>) : RegisterReposResult
    /** Nothing could be attempted at all — no usable Node, or the CLI could not be extracted. */
    data class Failed(val reason: String) : RegisterReposResult
}

/**
 * Registers one or more repositories into a workspace's own
 * `.copilot-architect/workspace.json`, by shelling out to the bundled CLI's
 * `workspace add <name> <path> --path <workspaceRoot>` — the only thing
 * that actually writes that file (`WorkspaceService.add` in
 * `packages/core`). No MCP tool exposes this: `workspace_map` only reads an
 * already-registered set. Without this, IntelliJ had no way to create a
 * multi-repo workspace at all — the VS Code extension's `setupRepo` calls
 * the very same CLI subcommand for the same reason.
 *
 * Kept free of IntelliJ Platform APIs, like [McpSetupService], so it can be
 * exercised directly in this sandbox.
 */
object RepoRegistrationService {
    private const val TIMEOUT_SECONDS = 60L

    fun registerRepos(
        classLoader: ClassLoader,
        cliExtractionDir: File,
        workspaceRoot: File,
        repos: List<RepoRegistration>
    ): RegisterReposResult {
        if (repos.isEmpty()) {
            return RegisterReposResult.Failed("No repositories were selected to register.")
        }

        val node = NodeLocator.find()
            ?: return RegisterReposResult.Failed(
                "Node.js was not found on this machine. Install it from " +
                    "https://nodejs.org (20.11 or later) and try again."
            )

        val version = readNodeVersion(node)
            ?: return RegisterReposResult.Failed(
                "Found Node at ${node.absolutePath} but could not read its version. " +
                    "Try running `${node.absolutePath} --version` yourself to see why."
            )

        if (version < MINIMUM_NODE_VERSION) {
            return RegisterReposResult.Failed(
                "Node $version was found at ${node.absolutePath}, but Copilot " +
                    "Architect needs $MINIMUM_NODE_VERSION or later. Install a newer " +
                    "version from https://nodejs.org and try again."
            )
        }

        val extraction = CliResourceExtractor.extract(classLoader, cliExtractionDir)
        val cliPath = when (extraction) {
            is CliExtractionResult.Failed -> return RegisterReposResult.Failed(extraction.reason)
            is CliExtractionResult.Extracted -> extraction.cliPath
        }

        val outcomes = repos.map { repo -> registerOne(node, cliPath, workspaceRoot, repo) }
        return RegisterReposResult.Completed(outcomes)
    }

    private fun registerOne(
        node: File,
        cliPath: File,
        workspaceRoot: File,
        repo: RepoRegistration
    ): RepoRegistrationOutcome {
        return try {
            val process = ProcessBuilder(
                node.absolutePath,
                cliPath.absolutePath,
                "workspace",
                "add",
                repo.name,
                repo.path.absolutePath,
                "--path",
                workspaceRoot.absolutePath
            )
                // Every path passed to the CLI above is already absolute, so this
                // has no effect on real behavior; it only gives a test a stable,
                // per-run directory to look for the fixture CLI's own output in.
                .directory(cliPath.parentFile)
                .redirectErrorStream(true)
                .start()

            val output = process.inputStream.bufferedReader().readText()
            val finished = process.waitFor(TIMEOUT_SECONDS, TimeUnit.SECONDS)

            if (!finished) {
                process.destroyForcibly()
                return RepoRegistrationOutcome.Failed(
                    repo.name,
                    "Timed out after ${TIMEOUT_SECONDS}s."
                )
            }

            if (process.exitValue() == 0) {
                RepoRegistrationOutcome.Registered(repo.name)
            } else {
                RepoRegistrationOutcome.Failed(
                    repo.name,
                    output.trim().ifEmpty { "Exited with code ${process.exitValue()}." }
                )
            }
        } catch (e: Exception) {
            RepoRegistrationOutcome.Failed(repo.name, e.message ?: e.toString())
        }
    }
}
