package com.creditoptimizer.plugin.settings

import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.project.Project
import com.intellij.ui.ToolbarDecorator
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBList
import java.awt.BorderLayout
import javax.swing.DefaultListModel
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * Settings > Tools > Credit Optimizer. Replaces hand-editing
 * `.idea/creditOptimizer.xml` directly: the toolbar's + opens a real
 * directory-only file chooser (so a developer never has to know or type
 * an absolute path by hand), - removes the selected row, and Apply writes
 * straight into the same [PluginSettings] state the XML already
 * round-trips — this adds a UI in front of existing storage, it does not
 * introduce a new one.
 */
class CreditOptimizerSettingsConfigurable(private val project: Project) : Configurable {

    private val listModel = DefaultListModel<String>()

    override fun getDisplayName(): String = "Credit Optimizer"

    override fun createComponent(): JComponent {
        val list = JBList(listModel)
        val decorator = ToolbarDecorator.createDecorator(list)
            .setAddAction {
                val descriptor = FileChooserDescriptorFactory.createSingleFolderDescriptor()
                val chosen = FileChooser.chooseFile(descriptor, project, null)
                if (chosen != null && !listModel.contains(chosen.path)) {
                    listModel.addElement(chosen.path)
                }
            }
            .setRemoveAction {
                for (index in list.selectedIndices.reversed()) {
                    listModel.remove(index)
                }
            }

        reset()

        return JPanel(BorderLayout(0, 6)).apply {
            border = javax.swing.BorderFactory.createEmptyBorder(10, 10, 10, 10)
            add(
                JBLabel(
                    "<html>Sibling service repos to index alongside the currently open project.<br>" +
                        "The currently open project is always included automatically.</html>"
                ),
                BorderLayout.NORTH
            )
            add(decorator.createPanel(), BorderLayout.CENTER)
        }
    }

    override fun isModified(): Boolean = currentPaths() != PluginSettings.getInstance(project).state.siblingRepoPaths

    override fun apply() {
        PluginSettings.getInstance(project).state.siblingRepoPaths = currentPaths().toMutableList()
    }

    override fun reset() {
        listModel.clear()
        PluginSettings.getInstance(project).state.siblingRepoPaths.forEach { listModel.addElement(it) }
    }

    private fun currentPaths(): List<String> = (0 until listModel.size()).map { listModel.getElementAt(it) }
}
