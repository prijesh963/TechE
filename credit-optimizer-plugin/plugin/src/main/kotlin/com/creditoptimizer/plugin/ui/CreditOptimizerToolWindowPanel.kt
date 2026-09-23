package com.creditoptimizer.plugin.ui

import com.creditoptimizer.core.usage.UsageKind
import com.creditoptimizer.plugin.AskOutcome
import com.creditoptimizer.plugin.IndexBridge
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import java.awt.BorderLayout
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.SwingConstants

/**
 * The Tool Window: index status, an ask box wired straight to
 * [IndexBridge.ask], and a running history of what was answered locally
 * versus handed to Copilot. Deliberately plain Swing, no JCEF — nothing
 * here needs an embedded browser, and a native panel needs no theme
 * bridging (see the intellij-main branch's `ThemeColors.kt` note on why
 * that mattered there).
 */
class CreditOptimizerToolWindowPanel(private val project: Project) {

    private val bridge = IndexBridge.getInstance(project)

    private val statusLabel = JBLabel().apply { horizontalAlignment = SwingConstants.LEFT }
    private val askField = JBTextField()
    private val resultArea = JBTextArea().apply {
        isEditable = false
        lineWrap = true
        wrapStyleWord = true
    }
    private val historyArea = JBTextArea().apply {
        isEditable = false
        lineWrap = true
        wrapStyleWord = true
    }

    val component: JPanel = JPanel(BorderLayout(0, 8)).apply {
        border = javax.swing.BorderFactory.createEmptyBorder(10, 10, 10, 10)

        add(buildStatusRow(), BorderLayout.NORTH)

        val center = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            add(buildAskRow())
            add(Box.createVerticalStrut(8))
            add(JBLabel("Answer").apply { alignmentX = 0f })
            add(JBScrollPane(resultArea).apply { preferredSize = java.awt.Dimension(320, 120) })
            add(Box.createVerticalStrut(10))
            add(JBLabel("History").apply { alignmentX = 0f })
            add(JBScrollPane(historyArea))
        }
        add(center, BorderLayout.CENTER)
    }

    init {
        refreshStatus()
        refreshHistory()
    }

    private fun buildStatusRow(): JPanel = JPanel(BorderLayout()).apply {
        add(statusLabel, BorderLayout.CENTER)
        val reindexButton = JButton("Reindex").apply {
            addActionListener {
                isEnabled = false
                statusLabel.text = "Indexing…"
                bridge.rebuildInBackground {
                    ApplicationManager.getApplication().invokeLater {
                        isEnabled = true
                        refreshStatus()
                    }
                }
            }
        }
        add(reindexButton, BorderLayout.EAST)
    }

    private fun buildAskRow(): JPanel = JPanel(BorderLayout(6, 0)).apply {
        alignmentX = 0f
        add(askField, BorderLayout.CENTER)
        val askButton = JButton("Ask")
        val submit = {
            val question = askField.text.trim()
            if (question.isNotEmpty()) {
                when (val outcome = bridge.ask(question)) {
                    is AskOutcome.Answered -> resultArea.text =
                        "● FROM INDEX — no credits used\n\n${outcome.summary}\n\n${outcome.detail}"
                    AskOutcome.NeedsCopilot -> resultArea.text =
                        "This needs Copilot — not answerable from the local index alone."
                }
                refreshHistory()
            }
        }
        askButton.addActionListener { submit() }
        askField.addActionListener { submit() }
        add(askButton, BorderLayout.EAST)
    }

    private fun refreshStatus() {
        val status = bridge.status()
        val share = status.localAnswerShare?.let { " · ${(it * 100).toInt()}% answered locally" } ?: ""
        statusLabel.text =
            "<html>${status.serviceCount} service(s), ${status.routeCount} route(s) &#183; built ${status.describeAge()}$share</html>"
    }

    private fun refreshHistory() {
        historyArea.text = bridge.recentHistory().joinToString("\n") { entry ->
            val tag = if (entry.kind == UsageKind.INDEX) "[INDEX]" else "[COPILOT]"
            "$tag ${entry.question}"
        }
    }
}
