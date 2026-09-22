package com.copilotarchitect.intellij

import com.intellij.ide.impl.OpenProjectTask
import com.intellij.ide.impl.ProjectUtil
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.VirtualFile
import java.nio.file.Path

/**
 * Dispatches an `architect-action:<id>` click from the dashboard's action row
 * (see `ActionLinkInterceptor`, and `buildDashboardActionsHtml` in
 * `packages/cli/src/index.ts`) to this plugin's own handling. Action ids are
 * shared with `vscode-extension`'s own command table
 * (`COPILOT_ARCHITECT_COMMANDS` / `DASHBOARD_PRIMARY_ACTIONS` /
 * `COPILOT_ARCHITECT_SECONDARY_ACTIONS`) so both shells agree on what each
 * action means without either importing the other's table — the Core Rule's
 * "duplication is an accepted, explicit tradeoff here" exception this phase
 * makes for the Setup/Scan orchestration also applies to this id list.
 *
 * Every id either runs through `CliBridge` (repo intelligence, the Core
 * Rule) or is IntelliJ-native window/process management that VS Code's own
 * equivalents (Stop MCP, Open Repo) are too — this dispatcher never
 * reimplements repo intelligence itself, only routes to it or to native IDE
 * APIs.
 *
 * All ids VS Code exposes are handled directly here — flat, not behind a
 * "More actions…" popup the way VS Code's quick pick hides the secondary
 * set. `packages/cli`'s `dashboard` command already renders every action
 * (primary and secondary) as one row (see `buildDashboardActionsHtml`), so a
 * second, IntelliJ-only grouping mechanism would only duplicate that
 * decision rather than add anything — the CLI's HTML is the one place the
 * action set is laid out.
 */
object ActionDispatcher {
    /** Truncated to keep the next dashboard render's CLI argv a reasonable size. */
    private const val MAX_OUTPUT_LENGTH = 4000

    data class Outcome(val label: String, val exitCode: Int, val stdout: String, val stderr: String)

    /**
     * Returns null when the action was cancelled or is a native IDE action
     * with no CLI outcome to report.
     *
     * Callers should invoke this off the EDT — `runCli` blocks for as long as
     * `CliBridge`'s CLI timeout. The two actions that need a folder picker
     * hop onto the EDT themselves for just that step (`pickFolder`, via
     * `invokeAndWait`), since `FileChooser` requires it; this function is
     * safe to call from a pooled thread either way.
     */
    fun dispatch(project: Project, actionId: String): Outcome? {
        val workspaceRoot = project.basePath
            ?: return Outcome(actionId, -1, "", "No project folder open.")

        // Plan actions carry a revision number in the id itself
        // (`approvePlan:<n>`, `showPlanDiff:<n>`) rather than being a fixed
        // id like every other action — see `buildPlanActionLinks` in
        // `packages/cli/src/index.ts` for why: the revision approved must be
        // the one this exact dashboard render showed, never "whatever is
        // newest".
        if (actionId.startsWith("approvePlan:")) {
            return dispatchApprovePlan(project, workspaceRoot, actionId)
        }

        if (actionId.startsWith("showPlanDiff:")) {
            return dispatchShowPlanDiff(project, workspaceRoot, actionId)
        }

        return when (actionId) {
            "setupRepo" -> runCli(workspaceRoot, "setup")
            "analyzeRepo" -> runCli(workspaceRoot, "analyze")
            "buildIndex" -> runCli(workspaceRoot, "index")
            "buildGraph" -> runCli(workspaceRoot, "graph")
            "generateInstructions" -> runCli(workspaceRoot, "instructions", "generate")
            "startAndSetupMcp" -> {
                val configResult = runCli(workspaceRoot, "mcp", "config")
                McpProcessManager.getInstance(project).start(workspaceRoot)
                configResult
            }
            "stopMcp" -> {
                McpProcessManager.getInstance(project).stop()
                Outcome("mcp stop", 0, "MCP server stopped.", "")
            }
            "workspaceScan" -> {
                val chosen = pickFolder(project) ?: return null
                runCli(workspaceRoot, "workspace", "scan", chosen.path)
            }
            "openRepoInNewWindow" -> {
                val chosen = pickFolder(project) ?: return null
                // Reuse this window rather than force a new one, matching
                // VS Code's own `forceNewWindow: false` — a fresh window can
                // launch without this plugin loaded on some install paths.
                // Opening a project is a UI operation — needs the EDT, same
                // as pickFolder above. `openOrImport`'s second parameter is
                // an OpenProjectTask (CI's compileKotlin caught the earlier
                // version of this line passing `project` directly, which
                // was never a valid overload).
                ApplicationManager.getApplication().invokeAndWait {
                    ProjectUtil.openOrImport(
                        Path.of(chosen.path),
                        OpenProjectTask(projectToClose = project, forceOpenInNewFrame = false)
                    )
                }
                null
            }
            else -> Outcome(actionId, -1, "", "Unknown action: $actionId")
        }
    }

    private fun runCli(workspaceRoot: String, vararg args: String): Outcome {
        val result = CliBridge.run(workspaceRoot, *args)
        return Outcome(
            label = args.joinToString(" "),
            exitCode = result.exitCode,
            stdout = truncate(result.stdout),
            stderr = truncate(result.stderr)
        )
    }

    /**
     * Approval is a real confirm dialog, not a click that silently runs a
     * command — the same "a button, not a phrase" gate the Safety Rules
     * apply to `@architect`'s own chat button, adapted to a shell with no
     * chat button to render. `approvedBy` is an audit field, not a choice,
     * so it is taken from the OS account rather than prompted for.
     */
    private fun dispatchApprovePlan(project: Project, workspaceRoot: String, actionId: String): Outcome? {
        val revision = actionId.removePrefix("approvePlan:").toIntOrNull()
            ?: return Outcome(actionId, -1, "", "Invalid plan approval action: $actionId")

        var confirmed = false
        ApplicationManager.getApplication().invokeAndWait {
            confirmed = Messages.showYesNoDialog(
                project,
                "Approve plan revision $revision? This freezes it for /implement. " +
                    "Use \"Show Plan Diff\" first if you have not reviewed what this revision changed.",
                "Approve Plan",
                Messages.getQuestionIcon()
            ) == Messages.YES
        }

        if (!confirmed) return null

        val approvedBy = System.getProperty("user.name") ?: "unknown"
        return runCli(workspaceRoot, "plan", "approve", "--revision", revision.toString(), "--by", approvedBy)
    }

    /**
     * Shown in its own read-only dialog rather than folded into the confirm
     * dialog above: a diff can run to many lines, and cramming it into a
     * Yes/No prompt would make the one question that dialog exists to ask —
     * approve or not — harder to see, not easier. Not run through `runCli`
     * (which truncates for the dashboard's "Last command" card) — a diff
     * shown as a review surface should not be silently cut off.
     */
    private fun dispatchShowPlanDiff(project: Project, workspaceRoot: String, actionId: String): Outcome? {
        val revision = actionId.removePrefix("showPlanDiff:").toIntOrNull()
            ?: return Outcome(actionId, -1, "", "Invalid plan diff action: $actionId")

        val result = CliBridge.run(workspaceRoot, "plan", "diff", "--to", revision.toString())

        if (result.exitCode != 0) {
            return Outcome("plan diff", result.exitCode, truncate(result.stdout), truncate(result.stderr))
        }

        ApplicationManager.getApplication().invokeLater {
            PlanDiffDialog(project, result.stdout, revision).show()
        }
        return null
    }

    /** `FileChooser` shows a modal dialog and requires the EDT — hop there and back. */
    private fun pickFolder(project: Project): VirtualFile? {
        val descriptor = FileChooserDescriptorFactory.createSingleFolderDescriptor()
        var chosen: VirtualFile? = null
        ApplicationManager.getApplication().invokeAndWait {
            chosen = FileChooser.chooseFile(descriptor, project, null)
        }
        return chosen
    }

    private fun truncate(value: String): String =
        if (value.length > MAX_OUTPUT_LENGTH) value.take(MAX_OUTPUT_LENGTH) + "…" else value
}
