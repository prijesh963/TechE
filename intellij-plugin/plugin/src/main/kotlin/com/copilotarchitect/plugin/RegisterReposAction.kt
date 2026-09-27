package com.copilotarchitect.plugin

import com.copilotarchitect.core.RegisterReposResult
import com.copilotarchitect.core.RepoRegistration
import com.copilotarchitect.core.RepoRegistrationOutcome
import com.copilotarchitect.core.RepoRegistrationService
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptor
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import java.io.File

/**
 * Tools-menu entry point for registering a folder's immediate
 * sub-directories as a multi-repo Copilot Architect workspace, rooted at
 * this IntelliJ project.
 *
 * No MCP tool can do this itself: `workspace_map` only reads an
 * already-registered set, and `.copilot-architect/workspace.json` is
 * otherwise only ever written by the CLI's own `workspace add` subcommand
 * (see RepoRegistrationService) — which is exactly what the VS Code
 * extension's "Setup Repo" -> "Multiple repos" flow shells out to. Without
 * this action, a multi-repo workspace could only be created from a
 * terminal, or by having already set one up from VS Code.
 *
 * A plain single-repo project needs none of this — search/list/plan tools
 * already fall back to single-repo behavior with no `workspace.json` at
 * all — so this action exists only for the multi-repo case.
 */
class RegisterReposAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val workspaceRoot = project.basePath?.let(::File) ?: return

        val descriptor = FileChooserDescriptor(false, true, false, false, false, false)
            .withTitle("Select the Folder Whose Sub-Directories Are Your Repositories")
            .withDescription(
                "Every immediate sub-directory is registered as a repository in this " +
                    "project's Copilot Architect workspace."
            )

        val chosen = FileChooser.chooseFile(descriptor, project, null) ?: return
        val reposDir = File(chosen.path)

        val subDirs = reposDir
            .listFiles { file -> file.isDirectory && !file.name.startsWith(".") }
            ?.sortedBy { it.name }
            ?: emptyList()

        if (subDirs.isEmpty()) {
            notify(
                project,
                "No repositories found",
                "${reposDir.absolutePath} has no sub-directories to register.",
                NotificationType.WARNING
            )
            return
        }

        object : Task.Backgroundable(
            project,
            "Registering Repositories with Copilot Architect",
            /* canBeCancelled = */ false
        ) {
            override fun run(indicator: ProgressIndicator) {
                // Same cache/generated-data directory runSetupAndNotify extracts
                // the CLI to — re-extracted every run, so a plugin update's newer
                // bundle is always what actually runs here too.
                val extractionDir = File(PathManager.getSystemPath(), "copilot-architect-mcp")
                val repos = subDirs.map { dir -> RepoRegistration(dir.name, dir) }
                val result = RepoRegistrationService.registerRepos(
                    RegisterReposAction::class.java.classLoader,
                    extractionDir,
                    workspaceRoot,
                    repos
                )
                notifyResult(project, result)
            }
        }.queue()
    }

    private fun notifyResult(project: Project, result: RegisterReposResult) {
        when (result) {
            is RegisterReposResult.Failed -> notify(
                project,
                "Could not register repositories",
                result.reason,
                NotificationType.ERROR
            )
            is RegisterReposResult.Completed -> {
                val registered = result.outcomes.filterIsInstance<RepoRegistrationOutcome.Registered>()
                val failed = result.outcomes.filterIsInstance<RepoRegistrationOutcome.Failed>()

                if (failed.isEmpty()) {
                    notify(
                        project,
                        "Registered ${registered.size} repositories",
                        registered.joinToString(", ") { it.name } +
                            " — /mcp.copilot-architect.* prompts now cover all of them.",
                        NotificationType.INFORMATION
                    )
                } else {
                    notify(
                        project,
                        "Registered ${registered.size} of ${result.outcomes.size} repositories",
                        failed.joinToString("\n") { "${it.name}: ${it.reason}" },
                        NotificationType.WARNING
                    )
                }
            }
        }
    }

    private fun notify(project: Project, title: String, content: String, type: NotificationType) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup(NOTIFICATION_GROUP_ID)
            .createNotification(title, content, type)
            .notify(project)
    }
}
