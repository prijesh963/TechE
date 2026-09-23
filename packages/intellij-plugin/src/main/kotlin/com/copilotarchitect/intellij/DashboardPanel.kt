package com.copilotarchitect.intellij

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.invokeLater
import com.intellij.openapi.project.Project
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import java.awt.BorderLayout
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.SwingConstants

/**
 * Renders the same dashboard the VS Code extension shows, via the CLI's
 * `dashboard` command (see `packages/cli` and `packages/dashboard`). This
 * panel owns no rendering logic of its own — only the JCEF host, the theme
 * injection that makes VS Code's own CSS variable names resolve to
 * IntelliJ's colors (see ThemeColors), the action-link click handling (see
 * ActionLinkInterceptor/ActionDispatcher), and the refresh trigger.
 *
 * The dashboard's action row is rendered by the CLI itself now (Phase 2),
 * but the runtime state around it — is the MCP server running, what did the
 * last click do — is this window's own, not the CLI's: a one-shot CLI call
 * has nothing to introspect, so this panel supplies both back in on every
 * render via `--mcp-status`/`--last-command`/etc., the same way it would
 * hold that state for its own UI if it rendered the dashboard directly.
 */
class DashboardPanel(private val project: Project) {
    val component: JPanel = JPanel(BorderLayout())
    private val browser: JBCefBrowser? = if (JBCefApp.isSupported()) JBCefBrowser() else null
    private val actionLinks: ActionLinkBridge? =
        browser?.let { ActionLinkBridge(it) { actionId, text -> handleAction(actionId, text) } }
    private var lastOutcome: ActionDispatcher.Outcome? = null

    /** The Copilot panel's text box, kept across re-renders (each click reloads the page). */
    private var task: String = ""
    private var notice: String? = null
    private var noticeIsError = false

    init {
        val hostedBrowser = browser
        if (hostedBrowser != null) {
            component.add(hostedBrowser.component, BorderLayout.CENTER)
            refresh()
        } else {
            component.add(
                JLabel(
                    "JCEF is not available in this IDE — the dashboard cannot render.",
                    SwingConstants.CENTER
                ),
                BorderLayout.CENTER
            )
        }
    }

    /**
     * The JS query handler fires off the EDT, and `ActionDispatcher.dispatch` can
     * block for as long as `CliBridge`'s 60s CLI timeout — run it on a pooled
     * thread rather than whatever thread JCEF calls back on, then hop back to
     * the EDT (`invokeLater`, required for `refresh()`'s Swing/JCEF calls).
     */
    private fun handleAction(actionId: String, text: String?) {
        if (text != null) task = text
        ApplicationManager.getApplication().executeOnPooledThread {
            if (CopilotActions.handles(actionId)) {
                val result = CopilotActions.dispatch(project, actionId, text)
                if (result != null) {
                    notice = result.notice
                    noticeIsError = result.isError
                    lastOutcome = result.outcome
                }
            } else {
                val outcome = ActionDispatcher.dispatch(project, actionId)
                if (outcome != null) {
                    lastOutcome = outcome
                }
            }
            invokeLater { refresh() }
        }
    }

    fun refresh() {
        val hostedBrowser = browser ?: return
        val workspaceRoot = project.basePath ?: return

        val args = mutableListOf("dashboard", "--path", workspaceRoot)
        args += "--mcp-status"
        args += McpProcessManager.getInstance(project).status
        lastOutcome?.let { outcome ->
            args += "--last-command"
            args += outcome.label
            args += "--last-exit-code"
            args += outcome.exitCode.toString()
            if (outcome.stdout.isNotBlank()) {
                args += "--last-stdout"
                args += outcome.stdout
            }
            if (outcome.stderr.isNotBlank()) {
                args += "--last-stderr"
                args += outcome.stderr
            }
        }

        if (task.isNotBlank()) {
            args += "--task"
            args += task
        }
        notice?.let { text ->
            args += "--notice"
            args += text
            if (noticeIsError) args += "--notice-error"
        }

        val result = CliBridge.run(workspaceRoot, *args.toTypedArray())

        val html = if (result.exitCode == 0) {
            injectTheme(result.stdout)
        } else {
            errorPage(result.stderr)
        }

        hostedBrowser.loadHTML(html)
    }

    private fun injectTheme(html: String): String {
        val themeStyle = ThemeColors.styleBlock() + (actionLinks?.clickScript() ?: "")
        return if (html.contains("<head>")) {
            html.replaceFirst("<head>", "<head>$themeStyle")
        } else {
            themeStyle + html
        }
    }

    private fun errorPage(stderr: String): String {
        val message = stderr.ifBlank { "Unknown error running the Copilot Architect CLI." }
        return """
            <html><body style="font-family:sans-serif;padding:16px;">
            <h2>Could not load the dashboard</h2>
            <pre style="white-space:pre-wrap">${escapeHtml(message)}</pre>
            </body></html>
        """.trimIndent()
    }

    private fun escapeHtml(value: String): String =
        value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
}
