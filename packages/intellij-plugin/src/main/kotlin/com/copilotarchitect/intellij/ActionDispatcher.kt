package com.copilotarchitect.intellij

import com.intellij.ide.impl.ProjectUtil
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.project.Project
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
                // as pickFolder above.
                ApplicationManager.getApplication().invokeAndWait {
                    ProjectUtil.openOrImport(Path.of(chosen.path), project)
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
