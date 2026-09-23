package com.creditoptimizer.plugin.settings

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.util.xmlb.XmlSerializerUtil

/**
 * Per-project configuration: the sibling microservice repos to index
 * alongside whichever one is currently open. Stored in the project's own
 * `.idea/creditOptimizer.xml` (not shared via `.copilot-architect`/VCS —
 * a developer's own disk layout for sibling checkouts is not something a
 * teammate's IDE should inherit).
 *
 * Edited through Settings > Tools > Credit Optimizer
 * ([CreditOptimizerSettingsConfigurable]), which binds to this exact state
 * shape — hand-editing the XML directly still works too, it's just no
 * longer the only way in.
 */
@State(name = "CreditOptimizerSettings", storages = [Storage("creditOptimizer.xml")])
class PluginSettings : PersistentStateComponent<PluginSettings.State> {

    data class State(
        /** Absolute paths to sibling service repos, in addition to the currently open project. */
        var siblingRepoPaths: MutableList<String> = mutableListOf()
    )

    private var state = State()

    override fun getState(): State = state

    override fun loadState(loadedState: State) {
        XmlSerializerUtil.copyBean(loadedState, state)
    }

    companion object {
        fun getInstance(project: Project): PluginSettings = project.service<PluginSettings>()
    }
}
