package com.copilotarchitect.plugin

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent

/** Tools-menu entry point for re-running setup manually — after a plugin update, or after declining the startup notification once and changing your mind. */
class SetUpMcpAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        runSetupAndNotify(project)
    }
}
