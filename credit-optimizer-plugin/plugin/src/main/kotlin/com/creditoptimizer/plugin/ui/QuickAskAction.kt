package com.creditoptimizer.plugin.ui

import com.creditoptimizer.plugin.AskOutcome
import com.creditoptimizer.plugin.IndexBridge
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.components.JBTextField
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.datatransfer.StringSelection
import javax.swing.JPanel
import javax.swing.KeyStroke

/**
 * Ctrl+Alt+K — the fast, in-flow entry point (see the design's "Quick
 * popup" mockups). Answers a plain factual question right in the popup
 * when the local index can; anything else is left for the Tool Window's
 * fuller "needs Copilot" flow rather than guessed at here.
 */
class QuickAskAction : AnAction() {

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val bridge = IndexBridge.getInstance(project)

        val field = JBTextField(36)
        val result = JBTextArea().apply {
            isEditable = false
            lineWrap = true
            wrapStyleWord = true
            isVisible = false
        }
        val badge = JBLabel().apply { isVisible = false }

        val panel = JPanel(BorderLayout(0, 6)).apply {
            add(field, BorderLayout.NORTH)
            val center = JPanel(BorderLayout(0, 4))
            center.add(badge, BorderLayout.NORTH)
            center.add(JBScrollPane(result).apply { preferredSize = Dimension(420, 160) }, BorderLayout.CENTER)
            add(center, BorderLayout.CENTER)
        }

        val popup = JBPopupFactory.getInstance()
            .createComponentPopupBuilder(panel, field)
            .setRequestFocus(true)
            .setResizable(true)
            .setTitle("Ask the local index")
            .createPopup()

        field.registerKeyboardAction(
            {
                val question = field.text.trim()
                if (question.isNotEmpty()) {
                    when (val outcome = bridge.ask(question)) {
                        is AskOutcome.Answered -> {
                            badge.text = "● FROM INDEX — no credits used"
                            badge.isVisible = true
                            result.text = "${outcome.summary}\n\n${outcome.detail}"
                            result.isVisible = true
                        }
                        is AskOutcome.NeedsCopilot -> {
                            CopyPasteManager.getInstance().setContents(StringSelection(outcome.groundedPrompt))
                            badge.text = "This needs Copilot — prompt copied to clipboard"
                            badge.isVisible = true
                            result.text = outcome.groundedPrompt
                            result.isVisible = true
                        }
                    }
                    panel.revalidate()
                }
            },
            KeyStroke.getKeyStroke("ENTER"),
            javax.swing.JComponent.WHEN_FOCUSED
        )

        popup.showCenteredInCurrentWindow(project)
    }
}
