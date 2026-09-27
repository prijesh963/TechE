package com.copilotarchitect.plugin

import com.copilotarchitect.core.McpSetupService
import com.copilotarchitect.core.SetupResult
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.project.Project
import java.io.File

const val NOTIFICATION_GROUP_ID = "Copilot Architect"

/**
 * Runs [McpSetupService.setup] against this IDE installation's own paths
 * and shows the result — the one piece of glue between the platform-free
 * orchestration in [McpSetupService] and the two platform-facing callers
 * ([SetupOnStartup]'s notification action, [SetUpMcpAction]'s menu item).
 *
 * `PathManager.getSystemPath()` — this installation's cache/generated-data
 * directory, not user settings — is where the extracted CLI lands; it is
 * re-extracted on every run, so a plugin update's newer bundle always wins
 * without anything stale left behind to accidentally run instead.
 */
fun runSetupAndNotify(project: Project) {
    val extractionDir = File(PathManager.getSystemPath(), "copilot-architect-mcp")
    val result = McpSetupService.setup(SetupRunnerAnchor::class.java.classLoader, extractionDir)

    val group = NotificationGroupManager.getInstance().getNotificationGroup(NOTIFICATION_GROUP_ID)
    val notification = when (result) {
        is SetupResult.Success -> group.createNotification(
            "Copilot Architect MCP server configured",
            "Wrote ${result.configPath.absolutePath}. Reload GitHub Copilot Chat's MCP " +
                "servers (or restart the IDE) to pick it up.",
            NotificationType.INFORMATION
        )
        is SetupResult.Failed -> group.createNotification(
            "Could not set up Copilot Architect MCP server",
            result.reason,
            NotificationType.ERROR
        )
    }
    notification.notify(project)
}

/** Anchors classloader resolution to this plugin's own JAR, not a caller's. */
private object SetupRunnerAnchor
