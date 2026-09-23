package com.creditoptimizer.core.handoff

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import java.io.File

/**
 * Every revision of every plan, one JSON file per plan id — local,
 * gitignored, same storage shape as [com.creditoptimizer.core.storage.IndexStorage].
 * Revisions are kept, not overwritten, so [CopilotHandoffService.importPlan]'s
 * revision-numbering and a later "what changed between drafts" both have
 * real history to work from.
 */
class PlanStorage(private val rootDir: File) {

    private val mapper: ObjectMapper = jacksonObjectMapper()

    init {
        rootDir.mkdirs()
    }

    fun saveRevision(plan: FeaturePlan) {
        val revisions = (loadAll(plan.id).filter { it.revision != plan.revision } + plan).sortedBy { it.revision }
        val file = fileFor(plan.id)
        file.parentFile?.mkdirs()
        mapper.writerWithDefaultPrettyPrinter().writeValue(file, revisions)
    }

    fun loadAll(id: String): List<FeaturePlan> {
        val file = fileFor(id)
        if (!file.exists()) return emptyList()
        return try {
            mapper.readValue<List<FeaturePlan>>(file)
        } catch (_: Exception) {
            emptyList()
        }
    }

    fun loadLatest(id: String): FeaturePlan? = loadAll(id).maxByOrNull { it.revision }

    private fun fileFor(id: String): File = File(rootDir, "${sanitize(id)}.json")

    private fun sanitize(id: String): String = id.replace(Regex("[^A-Za-z0-9_-]"), "_")
}
