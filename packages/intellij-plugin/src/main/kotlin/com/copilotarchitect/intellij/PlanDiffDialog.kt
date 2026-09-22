package com.copilotarchitect.intellij

import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.ui.components.JBScrollPane
import java.awt.Dimension
import java.awt.Font
import javax.swing.Action
import javax.swing.JComponent
import javax.swing.JTextArea

/**
 * Read-only display of `plan diff`'s text output, shown before an Approve
 * click so the developer's "yes" reflects what actually changed in this
 * revision rather than only its title. VS Code's own approve button sits
 * directly under the plan's rendered markdown in the chat turn that
 * proposed it — this plugin has no chat surface to render into, so the
 * review step this dialog gives happens in the Tool Window instead.
 *
 * Plain Swing (`JTextArea`/`JBScrollPane`), not an editor-style viewer,
 * matching this plugin's existing preference for the smallest API surface
 * that does the job (see ThemeColors.kt's own rationale for the same
 * choice). Like the rest of the Kotlin side, this has never been run in a
 * real IDE — see docs/KNOWN_LIMITATIONS.md 4.19.
 */
class PlanDiffDialog(project: Project, private val diffText: String, revision: Int) :
    DialogWrapper(project, false) {

    init {
        title = "Plan diff — revision $revision"
        setOKButtonText("Close")
        init()
    }

    override fun createCenterPanel(): JComponent {
        val textArea = JTextArea(diffText).apply {
            isEditable = false
            lineWrap = true
            wrapStyleWord = true
            font = Font(Font.MONOSPACED, Font.PLAIN, 12)
        }
        return JBScrollPane(textArea).apply {
            preferredSize = Dimension(640, 420)
        }
    }

    /** Read-only viewer — only "Close" is offered, no Cancel/OK ambiguity. */
    override fun createActions(): Array<Action> = arrayOf(okAction)
}
