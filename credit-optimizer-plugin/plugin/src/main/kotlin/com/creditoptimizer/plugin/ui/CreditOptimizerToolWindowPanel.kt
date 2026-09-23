package com.creditoptimizer.plugin.ui

import com.creditoptimizer.core.handoff.ChangeKind
import com.creditoptimizer.core.handoff.FeaturePlan
import com.creditoptimizer.core.usage.UsageKind
import com.creditoptimizer.plugin.AskOutcome
import com.creditoptimizer.plugin.IndexBridge
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import java.awt.BorderLayout
import java.awt.datatransfer.StringSelection
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.JSeparator
import javax.swing.SwingConstants

/**
 * The Tool Window: index status, an ask box wired straight to
 * [IndexBridge.ask], a running history, and the Plan/Implement hand-off.
 * Deliberately plain Swing, no JCEF — nothing here needs an embedded
 * browser, and a native panel needs no theme bridging (see the
 * intellij-main branch's `ThemeColors.kt` note on why that mattered
 * there).
 *
 * The Plan/Implement section is clipboard-mediated, not a shortcut: this
 * org's Copilot policy blocks MCP, GitHub Copilot Extensions (the only
 * mechanism that ever let a third-party tool respond to a typed
 * `@mention` across IDEs) were shut down in November 2025, and there is
 * no other API for a plugin to send text into Copilot Chat
 * programmatically. Draft/Approve/Implement each copy a grounded prompt
 * to the clipboard for you to paste into Copilot Chat yourself, and a
 * reply comes back the same way - pasted into this panel, not read from
 * Copilot automatically.
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

    private val requestField = JBTextField()
    private val planStatusArea = JBTextArea().apply {
        isEditable = false
        lineWrap = true
        wrapStyleWord = true
    }
    private val replyArea = JBTextArea().apply {
        rows = 6
        lineWrap = true
        wrapStyleWord = true
    }
    private val approveButton = JButton("Approve Plan")
    private val implementButton = JButton("Copy Implement Prompt")

    val component: JPanel = JPanel(BorderLayout(0, 8)).apply {
        border = javax.swing.BorderFactory.createEmptyBorder(10, 10, 10, 10)

        add(buildStatusRow(), BorderLayout.NORTH)

        val center = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS)
            add(buildAskRow())
            add(Box.createVerticalStrut(8))
            add(JBLabel("Answer").apply { alignmentX = 0f })
            add(JBScrollPane(resultArea).apply { preferredSize = java.awt.Dimension(320, 100) })
            add(Box.createVerticalStrut(14))
            add(JSeparator().apply { alignmentX = 0f })
            add(Box.createVerticalStrut(8))
            add(buildPlanSection())
            add(Box.createVerticalStrut(14))
            add(JBLabel("History").apply { alignmentX = 0f })
            add(JBScrollPane(historyArea))
        }
        add(JBScrollPane(center), BorderLayout.CENTER)
    }

    init {
        refreshStatus()
        refreshHistory()
        refreshPlanStatus()
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
                    is AskOutcome.NeedsCopilot -> {
                        copyToClipboard(outcome.groundedPrompt)
                        resultArea.text =
                            "This needs Copilot — prompt copied to clipboard, paste it into Copilot Chat:\n\n${outcome.groundedPrompt}"
                    }
                }
                refreshHistory()
            }
        }
        askButton.addActionListener { submit() }
        askField.addActionListener { submit() }
        add(askButton, BorderLayout.EAST)
    }

    private fun buildPlanSection(): JPanel = JPanel().apply {
        layout = BoxLayout(this, BoxLayout.Y_AXIS)
        alignmentX = 0f

        add(JBLabel("Plan a feature").apply { alignmentX = 0f })
        add(Box.createVerticalStrut(4))
        add(JPanel(BorderLayout(6, 0)).apply {
            alignmentX = 0f
            add(requestField, BorderLayout.CENTER)
            add(JButton("Draft Plan").apply {
                addActionListener {
                    val request = requestField.text.trim()
                    if (request.isNotEmpty()) {
                        copyToClipboard(bridge.draftPlanPrompt(request))
                        planStatusArea.text = "Plan prompt copied to clipboard — paste into Copilot Chat, then paste its reply below."
                    }
                }
            }, BorderLayout.EAST)
        })

        add(Box.createVerticalStrut(8))
        add(JBLabel("Paste Copilot's reply").apply { alignmentX = 0f })
        add(JBScrollPane(replyArea).apply { alignmentX = 0f })
        add(Box.createVerticalStrut(4))
        add(JButton("Import Reply").apply {
            alignmentX = 0f
            addActionListener {
                val request = requestField.text.trim()
                val reply = replyArea.text
                if (request.isNotEmpty() && reply.isNotBlank()) {
                    bridge.importPlanReply(request, reply)
                    replyArea.text = ""
                    refreshPlanStatus()
                }
            }
        })

        add(Box.createVerticalStrut(8))
        add(JBLabel("Current plan").apply { alignmentX = 0f })
        add(JBScrollPane(planStatusArea).apply { alignmentX = 0f; preferredSize = java.awt.Dimension(320, 100) })
        add(Box.createVerticalStrut(4))
        add(JPanel(BorderLayout(6, 0)).apply {
            alignmentX = 0f
            add(approveButton, BorderLayout.WEST)
            add(implementButton, BorderLayout.EAST)
        })

        approveButton.addActionListener {
            bridge.approveCurrentPlan()
            refreshPlanStatus()
        }
        implementButton.addActionListener {
            val prompt = bridge.buildImplementPrompt()
            if (prompt != null) {
                copyToClipboard(prompt)
                planStatusArea.text = "Implement prompt copied to clipboard — paste into Copilot Chat.\n\n$prompt"
            }
        }
    }

    private fun copyToClipboard(text: String) {
        CopyPasteManager.getInstance().setContents(StringSelection(text))
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

    private fun refreshPlanStatus() {
        val plan = bridge.currentPlan()
        approveButton.isEnabled = plan != null && !plan.approved
        implementButton.isEnabled = plan != null && plan.approved
        planStatusArea.text = if (plan == null) "(no plan yet)" else describePlan(plan)
    }

    private fun describePlan(plan: FeaturePlan): String = buildString {
        append("Revision ${plan.revision}")
        append(if (plan.approved) " — APPROVED\n" else " — draft\n")
        append(plan.summary)
        append("\n\nFiles:\n")
        plan.files.forEach { file ->
            val verb = when (file.kind) {
                ChangeKind.ADD -> "ADD"
                ChangeKind.UPDATE -> "UPDATE"
                ChangeKind.DELETE -> "DELETE"
            }
            append("  $verb ${file.service}/${file.path} — ${file.reason}\n")
        }
        if (plan.steps.isNotEmpty()) {
            append("\nSteps:\n")
            plan.steps.forEach { append("  - $it\n") }
        }
    }
}
