package com.copilotarchitect.plugin

import com.copilotarchitect.core.McpConfigWriter
import com.intellij.ide.util.PropertiesComponent
import com.intellij.notification.Notification
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity

private const val DISMISSED_KEY = "copilotArchitect.mcp.setup.dismissed"

/**
 * Offers setup once per developer, on project open — not a silent write.
 *
 * The MCP config this writes to is global (shared across every IntelliJ
 * project, not scoped to this one), so writing it without any action from
 * the developer would be a surprising thing for opening one particular
 * project to do. A notification with an explicit "Set Up" makes it a
 * decision they made, not something that just happened.
 */
class SetupOnStartup : ProjectActivity {
    override suspend fun execute(project: Project) {
        val properties = PropertiesComponent.getInstance()
        if (properties.getBoolean(DISMISSED_KEY, false)) {
            return
        }

        if (McpConfigWriter.isConfigured(McpConfigWriter.resolveConfigPath())) {
            // Already set up — by this plugin, or by hand. Either way there is
            // nothing to offer, and the flag above is for "declined", not this.
            return
        }

        val notification = NotificationGroupManager.getInstance()
            .getNotificationGroup(NOTIFICATION_GROUP_ID)
            .createNotification(
                "Set up Copilot Architect for GitHub Copilot Chat?",
                "Points Copilot Chat's MCP connection at this machine's local Copilot " +
                    "Architect server, so /mcp.copilot-architect.* commands are grounded " +
                    "in this repo's real structure. Requires Node.js 20.11+.",
                NotificationType.INFORMATION
            )

        notification.addAction(object : NotificationAction("Set Up") {
            override fun actionPerformed(e: AnActionEvent, notif: Notification) {
                runSetupAndNotify(project)
                notif.expire()
            }
        })
        notification.addAction(object : NotificationAction("Don't ask again") {
            override fun actionPerformed(e: AnActionEvent, notif: Notification) {
                properties.setValue(DISMISSED_KEY, true)
                notif.expire()
            }
        })

        notification.notify(project)
    }
}
