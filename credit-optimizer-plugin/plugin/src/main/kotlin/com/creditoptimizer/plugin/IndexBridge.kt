package com.creditoptimizer.plugin

import com.creditoptimizer.core.IndexService
import com.creditoptimizer.core.handoff.CopilotHandoffService
import com.creditoptimizer.core.handoff.FeaturePlan
import com.creditoptimizer.core.handoff.PlanStorage
import com.creditoptimizer.core.model.ServiceIndex
import com.creditoptimizer.core.model.ServiceInfo
import com.creditoptimizer.core.router.FreePathRouter
import com.creditoptimizer.core.router.RouterResult
import com.creditoptimizer.core.storage.IndexStorage
import com.creditoptimizer.core.usage.UsageEntry
import com.creditoptimizer.core.usage.UsageKind
import com.creditoptimizer.core.usage.UsageLog
import com.creditoptimizer.plugin.settings.PluginSettings
import com.intellij.openapi.components.service
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import java.io.File
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

/**
 * The project-level wiring between the IDE and `:core` — this is the only
 * class in the plugin module that touches [IndexService]/[FreePathRouter]/
 * [UsageLog] directly, so every other IDE-facing class (the tool window,
 * the quick-ask action) depends on this, never on `:core` piecemeal.
 *
 * Storage lives under the project's own `.idea/creditOptimizer/` — local,
 * gitignored, per developer (see the design's "local-per-developer" choice
 * over a shared/central index).
 */
class IndexBridge(private val project: Project) {

    // project.basePath is nullable (a default/light project has none); "." falls back to
    // the process working directory rather than failing service construction over it.
    private val dataDir: File = File(project.basePath ?: ".", ".idea/creditOptimizer")
    private val indexService = IndexService(IndexStorage(File(dataDir, "index")))
    private val usageLog = UsageLog(File(dataDir, "usage.jsonl"))
    private val planStorage = PlanStorage(File(dataDir, "plans"))

    /** One feature in flight at a time, same as the old Copilot Architect project's session model — no plan-id UI needed. */
    private val currentPlanId = "current"

    @Volatile
    private var lastBuiltAt: Instant? = null

    /** The currently open project, plus every sibling repo configured in [PluginSettings]. */
    private fun configuredServices(): List<ServiceInfo> {
        val current = project.basePath?.let {
            ServiceInfo(name = File(it).name, rootPath = it)
        }
        val siblings = PluginSettings.getInstance(project).state.siblingRepoPaths
            .map { ServiceInfo(name = File(it).name, rootPath = it) }
        return listOfNotNull(current) + siblings
    }

    fun status(): IndexStatus {
        val indexes = indexService.loadAll()
        return IndexStatus(
            serviceCount = indexes.size,
            routeCount = indexes.sumOf { it.routes.size },
            builtAt = lastBuiltAt,
            localAnswerShare = usageLog.localAnswerShare()
        )
    }

    /** Runs the full/incremental index build as a background task, then invokes [onDone] on completion. */
    fun rebuildInBackground(onDone: () -> Unit) {
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Building local index", true) {
            override fun run(indicator: ProgressIndicator) {
                val services = configuredServices()
                for ((index, service) in services.withIndex()) {
                    indicator.text = "Indexing ${service.name}…"
                    indicator.fraction = index.toDouble() / services.size
                    indexService.buildOne(service)
                }
                lastBuiltAt = Instant.now()
            }

            override fun onFinished() {
                onDone()
            }
        })
    }

    /**
     * Answers [question] from the index when it is a plain factual lookup;
     * every call is logged as INDEX or COPILOT so [IndexStatus.localAnswerShare]
     * reflects real use, not an estimate.
     */
    fun ask(question: String): AskOutcome {
        val indexes: List<ServiceIndex> = indexService.loadAll()
        return when (val result = FreePathRouter.answer(question, indexes)) {
            is RouterResult.LocalAnswer -> {
                usageLog.record(UsageEntry(question, UsageKind.INDEX, result.summary))
                AskOutcome.Answered(result.summary, result.detail, result.sourceFiles)
            }
            RouterResult.NeedsGeneration -> {
                usageLog.record(UsageEntry(question, UsageKind.COPILOT, "handed to Copilot"))
                AskOutcome.NeedsCopilot(CopilotHandoffService.buildAskPrompt(question, indexes))
            }
        }
    }

    fun recentHistory(limit: Int = 30) = usageLog.recent(limit)

    // --- Plan / implement hand-off ---------------------------------------------------
    // Clipboard-mediated by design, not a shortcut: there is no API for a plugin to send
    // text into Copilot Chat programmatically, and this org's Copilot policy blocks MCP
    // (the one mechanism that could have made this a `/mcp...` prompt instead). This is
    // the real ceiling of what's possible here, not a placeholder for something better.

    fun currentPlan(): FeaturePlan? = planStorage.loadLatest(currentPlanId)

    /** Builds the prompt to copy into Copilot Chat for a new plan draft; does not persist anything yet. */
    fun draftPlanPrompt(request: String): String =
        CopilotHandoffService.buildPlanPrompt(request, indexService.loadAll())

    /**
     * Parses Copilot's pasted reply into the next plan revision and persists it.
     * Always a new revision, never approved - re-importing after edits is how a
     * plan gets corrected, matching the old project's versioned-plan rule.
     */
    fun importPlanReply(request: String, reply: String): FeaturePlan {
        val plan = CopilotHandoffService.importPlan(currentPlanId, request, reply, indexService.loadAll(), currentPlan())
        planStorage.saveRevision(plan)
        return plan
    }

    /** Approves the current plan revision exactly as it stands - never "whatever is newest" implicitly. */
    fun approveCurrentPlan(): FeaturePlan? {
        val plan = currentPlan() ?: return null
        val approved = CopilotHandoffService.approve(plan)
        planStorage.saveRevision(approved)
        return approved
    }

    /** Null when there is no plan, or the current one is still a draft - implementing a draft is refused, not just discouraged. */
    fun buildImplementPrompt(): String? {
        val plan = currentPlan() ?: return null
        return CopilotHandoffService.buildImplementPrompt(plan, indexService.loadAll())
    }

    companion object {
        fun getInstance(project: Project): IndexBridge = project.service<IndexBridge>()
    }
}

data class IndexStatus(
    val serviceCount: Int,
    val routeCount: Int,
    val builtAt: Instant?,
    val localAnswerShare: Double?
) {
    fun describeAge(): String {
        val at = builtAt ?: return "never indexed"
        val minutes = ChronoUnit.MINUTES.between(at, Instant.now())
        return when {
            minutes < 1 -> "just now"
            minutes < 60 -> "$minutes min ago"
            else -> DateTimeFormatter.ofPattern("MMM d, HH:mm").format(at.atZone(java.time.ZoneId.systemDefault()))
        }
    }
}

sealed interface AskOutcome {
    data class Answered(val summary: String, val detail: String, val sourceFiles: List<String>) : AskOutcome
    /** [groundedPrompt] is what to copy into Copilot Chat - built from the same indexed facts an [Answered] would have quoted. */
    data class NeedsCopilot(val groundedPrompt: String) : AskOutcome
}
