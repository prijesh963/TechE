package com.copilotarchitect.intellij

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindowManager
import java.awt.datatransfer.DataFlavor
import java.awt.datatransfer.StringSelection
import java.io.File

/**
 * The "Work with Copilot Chat" panel's buttons — the workflow for an
 * organization whose Copilot policy blocks MCP servers, so Copilot cannot
 * call Copilot Architect's tools itself (see `docs/KNOWN_LIMITATIONS.md`
 * 4.26).
 *
 * Every step's logic is the CLI's `copilot` command (`CopilotHandoffService`
 * in `packages/planner`); this object only does what only the IDE can: put
 * a prompt on the clipboard, read Copilot's reply back off it, show the
 * Copilot Chat window, and ask for approval with a real dialog. Prompts and
 * replies travel as temp files, so this side never parses CLI output.
 */
object CopilotActions {
    private val log = Logger.getInstance(CopilotActions::class.java)

    /**
     * Tool window ids GitHub Copilot's JetBrains plugin has used for its chat.
     * Not a public API, so every one is tried and none is required: if none
     * matches, the notice tells the developer to open Copilot Chat themselves.
     */
    private val COPILOT_CHAT_TOOL_WINDOW_IDS = listOf("GitHub Copilot Chat", "Copilot Chat", "GitHub Copilot")

    private val PASTE_HINT =
        if (System.getProperty("os.name").orEmpty().lowercase().contains("mac")) "⌘V" else "Ctrl+V"

    data class Result(val notice: String, val isError: Boolean, val outcome: ActionDispatcher.Outcome)

    fun handles(actionId: String): Boolean = actionId.startsWith("copilot")

    /** Blocks on the CLI: call off the EDT, as `ActionDispatcher.dispatch` is. */
    fun dispatch(project: Project, actionId: String, text: String?): Result? {
        val workspaceRoot = project.basePath ?: return failure(actionId, "No project folder open.")

        return when {
            actionId == "copilotAsk" -> promptStep(project, workspaceRoot, "ask", text)
            actionId == "copilotPlan" -> promptStep(project, workspaceRoot, "plan", text)
            actionId == "copilotImplement" -> promptStep(project, workspaceRoot, "implement", null)
            actionId == "copilotImport" -> importPlan(workspaceRoot)
            actionId.startsWith("copilotApprove:") -> approvePlan(project, workspaceRoot, actionId)
            else -> failure(actionId, "Unknown action: $actionId")
        }
    }

    private fun promptStep(project: Project, workspaceRoot: String, step: String, text: String?): Result {
        val promptFile = File.createTempFile("copilot-architect-prompt", ".md")
        try {
            val args = mutableListOf("copilot", step, "--path", workspaceRoot, "--prompt-out", promptFile.path)
            if (text != null) {
                args += "--text"
                args += text
            }

            val result = CliBridge.run(workspaceRoot, *args.toTypedArray())
            val outcome = outcomeOf("copilot $step", result)
            if (result.exitCode != 0) {
                return Result(result.stderr.trim().ifBlank { "Copilot Architect could not prepare the prompt." }, true, outcome)
            }

            val prompt = promptFile.readText()
            var opened = false
            ApplicationManager.getApplication().invokeAndWait {
                CopyPasteManager.getInstance().setContents(StringSelection(prompt))
                opened = showCopilotChat(project)
            }

            val where = if (opened) "Copilot Chat is open" else "Open Copilot Chat"
            val mode = if (step == "implement") " (Agent mode)" else ""
            val notice = "${result.stdout.trim()} Copied to the clipboard — $where$mode, paste with $PASTE_HINT and press Enter."
            return Result(notice, false, outcome)
        } finally {
            promptFile.delete()
        }
    }

    private fun importPlan(workspaceRoot: String): Result {
        var copied: String? = null
        ApplicationManager.getApplication().invokeAndWait {
            copied = try {
                CopyPasteManager.getInstance().getContents<String>(DataFlavor.stringFlavor)
            } catch (error: Exception) {
                log.warn("Could not read the clipboard", error)
                null
            }
        }

        val reply = copied
        if (reply.isNullOrBlank()) {
            return failure("copilot import", "The clipboard has no text. In Copilot Chat, click Copy on Copilot's reply, then click Import again.")
        }

        val responseFile = File.createTempFile("copilot-architect-reply", ".txt")
        try {
            responseFile.writeText(reply)
            val result = CliBridge.run(workspaceRoot, "copilot", "import", "--path", workspaceRoot, "--response-file", responseFile.path)
            return fromCli("copilot import", result)
        } finally {
            responseFile.delete()
        }
    }

    /**
     * Approval is a real dialog, never a phrase — the same gate as the plan
     * approval `ActionDispatcher` handles for MCP-drafted plans. The version
     * comes from the button the developer clicked, which carries the version
     * that render showed, so a newer import can never be approved unseen.
     */
    private fun approvePlan(project: Project, workspaceRoot: String, actionId: String): Result? {
        val version = actionId.removePrefix("copilotApprove:").toIntOrNull()
            ?: return failure(actionId, "Invalid approve action: $actionId")

        var confirmed = false
        ApplicationManager.getApplication().invokeAndWait {
            confirmed = Messages.showYesNoDialog(
                project,
                "Approve plan v$version? Copilot will be asked to change exactly the files it lists.",
                "Approve Plan",
                Messages.getQuestionIcon()
            ) == Messages.YES
        }
        if (!confirmed) return null

        val result = CliBridge.run(workspaceRoot, "copilot", "approve", "--path", workspaceRoot, "--version", version.toString())
        return fromCli("copilot approve", result)
    }

    private fun showCopilotChat(project: Project): Boolean {
        val manager = ToolWindowManager.getInstance(project)
        val window = COPILOT_CHAT_TOOL_WINDOW_IDS.firstNotNullOfOrNull { manager.getToolWindow(it) } ?: return false
        window.activate(null)
        return true
    }

    private fun fromCli(label: String, result: CliResult): Result {
        val outcome = outcomeOf(label, result)
        return if (result.exitCode == 0) {
            Result(result.stdout.trim(), false, outcome)
        } else {
            Result(result.stderr.trim().ifBlank { "$label failed." }, true, outcome)
        }
    }

    private fun outcomeOf(label: String, result: CliResult) =
        ActionDispatcher.Outcome(label, result.exitCode, result.stdout.take(4000), result.stderr.take(4000))

    private fun failure(label: String, message: String) =
        Result(message, true, ActionDispatcher.Outcome(label, -1, "", message))
}
