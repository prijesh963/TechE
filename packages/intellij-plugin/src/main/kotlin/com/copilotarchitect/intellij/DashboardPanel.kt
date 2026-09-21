package com.copilotarchitect.intellij

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
 * IntelliJ's colors (see ThemeColors), and the refresh trigger.
 */
class DashboardPanel(private val project: Project) {
    val component: JPanel = JPanel(BorderLayout())
    private val browser: JBCefBrowser? = if (JBCefApp.isSupported()) JBCefBrowser() else null

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

    fun refresh() {
        val hostedBrowser = browser ?: return
        val workspaceRoot = project.basePath ?: return
        val result = CliBridge.run(workspaceRoot, "dashboard", "--path", workspaceRoot)

        val html = if (result.exitCode == 0) {
            injectTheme(result.stdout)
        } else {
            errorPage(result.stderr)
        }

        hostedBrowser.loadHTML(html)
    }

    private fun injectTheme(html: String): String {
        val themeStyle = ThemeColors.styleBlock()
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
