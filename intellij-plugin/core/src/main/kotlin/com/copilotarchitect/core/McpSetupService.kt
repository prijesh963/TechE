package com.copilotarchitect.core

import java.io.File

sealed interface SetupResult {
    data class Success(val configPath: File, val backupPath: File?) : SetupResult
    data class Failed(val reason: String) : SetupResult
}

/**
 * Orchestrates Node discovery, CLI extraction, and the global MCP config
 * write — kept free of any IntelliJ platform API so it can be exercised by
 * a plain JUnit test. This sandbox cannot resolve the IntelliJ Platform
 * distribution needed to run platform-test-framework tests at all (see
 * build.gradle.kts); real verification of the platform-facing callers
 * (`SetupOnStartup`, `SetUpMcpAction`) is CI, on a runner with no such
 * restriction. This class is where the actual decisions live, so it is the
 * one piece verified directly, here, regardless.
 */
object McpSetupService {
    fun setup(
        classLoader: ClassLoader,
        cliExtractionDir: File,
        configFile: File = McpConfigWriter.resolveConfigPath()
    ): SetupResult {
        val node = NodeLocator.find()
            ?: return SetupResult.Failed(
                "Node.js was not found on this machine. Install it from " +
                    "https://nodejs.org (20.11 or later) and try again."
            )

        val version = readNodeVersion(node)
            ?: return SetupResult.Failed(
                "Found Node at ${node.absolutePath} but could not read its version. " +
                    "Try running `${node.absolutePath} --version` yourself to see why."
            )

        if (version < MINIMUM_NODE_VERSION) {
            return SetupResult.Failed(
                "Node $version was found at ${node.absolutePath}, but Copilot " +
                    "Architect needs $MINIMUM_NODE_VERSION or later. Install a newer " +
                    "version from https://nodejs.org and try again."
            )
        }

        val extraction = CliResourceExtractor.extract(classLoader, cliExtractionDir)
        val cliPath = when (extraction) {
            is CliExtractionResult.Failed -> return SetupResult.Failed(extraction.reason)
            is CliExtractionResult.Extracted -> extraction.cliPath
        }

        val written = McpConfigWriter.merge(configFile, node.absolutePath, cliPath.absolutePath)
        return when (written) {
            is McpConfigResult.Failed -> SetupResult.Failed(written.reason)
            is McpConfigResult.Written ->
                SetupResult.Success(written.configPath, written.backupPath)
        }
    }
}
