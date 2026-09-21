package com.copilotarchitect.intellij

import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project

/**
 * This IDE window's own handle on the local MCP server process — the same
 * shell-local state VS Code's `activeMcpProcess` is (see
 * `vscode-extension/src/index.ts`, `startMcp`/`stopMcp`). A running process
 * cannot be reported by a one-shot CLI call, so this manager, not the CLI, is
 * the source of truth `DashboardPanel` reads from before every render — the
 * dashboard's `--mcp-status` flag exists specifically for a caller like this
 * one to supply it (see `packages/cli`'s `dashboard` command).
 *
 * A project-level light service: IntelliJ creates and disposes one instance
 * per open project without any `plugin.xml` registration (2024.2+).
 */
@Service(Service.Level.PROJECT)
class McpProcessManager {
    private val log = Logger.getInstance(McpProcessManager::class.java)

    @Volatile
    private var process: Process? = null

    val status: String
        get() = if (process?.isAlive == true) "running" else "stopped"

    /** No-op if a server is already running — mirrors VS Code's own guard in `startMcp`. */
    fun start(workspaceRoot: String) {
        if (process?.isAlive == true) return
        try {
            process = CliBridge.spawn(workspaceRoot, "mcp")
        } catch (error: Exception) {
            log.warn("Failed to start the Copilot Architect MCP server", error)
        }
    }

    fun stop() {
        process?.destroy()
        process = null
    }

    companion object {
        fun getInstance(project: Project): McpProcessManager =
            project.getService(McpProcessManager::class.java)
    }
}
