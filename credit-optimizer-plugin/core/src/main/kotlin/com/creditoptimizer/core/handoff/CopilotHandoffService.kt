package com.creditoptimizer.core.handoff

import com.creditoptimizer.core.model.ServiceIndex
import java.io.File

/**
 * Builds the prompts a developer pastes into Copilot Chat, and turns
 * Copilot's output back into a [FeaturePlan] — either parsed from pasted
 * text ([importPlan]) or recorded directly from structured arguments
 * ([recordPlan], for an MCP tool call where Copilot already supplies
 * files/steps rather than free text). There is no API that lets a
 * third-party plugin send text into Copilot Chat programmatically, so
 * Plan/Implement stay clipboard-mediated by design; [recordPlan] is the
 * one path that skips the clipboard, because drafting a plan only ever
 * writes to this project's own plan storage, never to source code, and
 * never sets [FeaturePlan.approved] - approval and Implement stay a
 * human action regardless of how the draft got recorded.
 *
 * The value this project adds is not the reasoning - that's still
 * Copilot's job, and still spends credits doing it. It's *grounding*:
 * every prompt is built from real facts [ContextRetrieval] found in the
 * index, not a whole-file dump, so each Copilot call is narrower, cheaper,
 * and less likely to need a second corrective round.
 */
object CopilotHandoffService {

    fun buildAskPrompt(question: String, indexes: List<ServiceIndex>): String {
        val candidates = ContextRetrieval.topCandidates(question, indexes)
        return buildString {
            appendLine("You are answering a question about a Java/Spring Boot microservices workspace.")
            appendLine("Use the indexed facts below as ground truth. If they don't cover the question, say what's missing rather than guessing.")
            appendLine()
            appendLine("## Indexed facts")
            if (candidates.isEmpty()) {
                appendLine("(no closely matching facts found in the index for this question)")
            } else {
                candidates.forEach { appendLine("- [${it.service}/${it.sourceFile}] ${it.text}") }
            }
            appendLine()
            appendLine("## Question")
            appendLine(question)
        }
    }

    fun buildPlanPrompt(request: String, indexes: List<ServiceIndex>): String {
        val candidates = ContextRetrieval.topCandidates(request, indexes)
        return buildString {
            appendLine("You are drafting an implementation plan for a Java/Spring Boot microservices workspace.")
            appendLine("The indexed facts below are your starting context for which files and services are relevant - use them, and name specific files under the services involved.")
            appendLine()
            appendLine("## Indexed facts")
            if (candidates.isEmpty()) {
                appendLine("(no closely matching facts found in the index for this request)")
            } else {
                candidates.forEach { appendLine("- [${it.service}/${it.sourceFile}] ${it.text}") }
            }
            appendLine()
            appendLine("## Feature request")
            appendLine(request)
            appendLine()
            appendLine("## Reply in exactly this format, one item per line, nothing else")
            appendLine("SUMMARY: <one paragraph describing the approach>")
            appendLine("FILE: <ADD|UPDATE|DELETE> <service>/<relative/path/To.java> — <why this file>")
            appendLine("STEP: <what happens, one line per step>")
        }
    }

    /**
     * Parses a pasted Copilot reply into a new [FeaturePlan] revision. An
     * `UPDATE`/`DELETE` naming a path the index has never indexed for that
     * service is dropped, not trusted — the same "an invented path never
     * becomes a fact" rule [com.creditoptimizer.core.router.FreePathRouter]
     * follows elsewhere. `ADD` has nothing to check against a not-yet-real
     * file, so any path is accepted.
     */
    fun importPlan(id: String, request: String, reply: String, indexes: List<ServiceIndex>, previous: FeaturePlan? = null): FeaturePlan {
        val knownPaths: Map<String, Set<String>> = indexes.associate { it.service.name to it.fileHashes.keys }

        var summary = ""
        val files = mutableListOf<PlannedFile>()
        val steps = mutableListOf<String>()

        for (rawLine in reply.lines()) {
            val line = rawLine.trim()
            when {
                line.startsWith("SUMMARY:", ignoreCase = true) -> summary = line.substringAfter(":").trim()
                line.startsWith("FILE:", ignoreCase = true) -> parseFileLine(line.substringAfter(":").trim(), knownPaths)?.let { files += it }
                line.startsWith("STEP:", ignoreCase = true) -> steps += line.substringAfter(":").trim().let { if (it.isNotEmpty()) it else null } ?: continue
            }
        }

        return FeaturePlan(
            id = id,
            request = request,
            revision = (previous?.revision ?: 0) + 1,
            summary = summary,
            files = files,
            steps = steps,
            approved = false
        )
    }

    private val FILE_LINE = Regex("""^(ADD|UPDATE|DELETE)\s+([\w.\-]+)/(.+?)\s+[—-]\s+(.+)$""", RegexOption.IGNORE_CASE)

    private fun parseFileLine(text: String, knownPaths: Map<String, Set<String>>): PlannedFile? {
        val match = FILE_LINE.find(text) ?: return null
        val kind = ChangeKind.valueOf(match.groupValues[1].uppercase())
        val service = match.groupValues[2]
        val path = match.groupValues[3].trim()
        val reason = match.groupValues[4].trim()

        val file = PlannedFile(service, path, kind, reason)
        return if (isKnownOrAdd(file, knownPaths)) file else null
    }

    /**
     * Records a plan drafted directly (e.g. by an MCP tool call, where the
     * caller already supplies structured files/steps rather than text to
     * parse) as a new revision — the same invented-path-dropped rule
     * [importPlan] applies to a pasted reply, just applied to already-
     * structured input instead of parsed lines. Read-only with respect to
     * source code: this only ever writes to plan storage, never to a
     * project file, and never sets [FeaturePlan.approved] - that stays a
     * human action via [approve].
     */
    fun recordPlan(
        id: String,
        request: String,
        summary: String,
        files: List<PlannedFile>,
        steps: List<String>,
        indexes: List<ServiceIndex>,
        previous: FeaturePlan? = null
    ): FeaturePlan {
        val knownPaths: Map<String, Set<String>> = indexes.associate { it.service.name to it.fileHashes.keys }
        return FeaturePlan(
            id = id,
            request = request,
            revision = (previous?.revision ?: 0) + 1,
            summary = summary,
            files = files.filter { isKnownOrAdd(it, knownPaths) },
            steps = steps,
            approved = false
        )
    }

    private fun isKnownOrAdd(file: PlannedFile, knownPaths: Map<String, Set<String>>): Boolean {
        if (file.kind == ChangeKind.ADD) return true
        return file.path in (knownPaths[file.service] ?: return false)
    }

    fun approve(plan: FeaturePlan): FeaturePlan = plan.copy(approved = true)

    /**
     * Refuses (returns null) for a draft plan - approval is explicit and
     * required before any implement prompt exists, same as the old
     * Copilot Architect project's plan-contract rule. For an `UPDATE`
     * file, the current on-disk content is quoted in so Copilot edits
     * against exact ground truth rather than its memory of the file.
     */
    fun buildImplementPrompt(plan: FeaturePlan, indexes: List<ServiceIndex>): String? {
        if (!plan.approved) return null
        val rootsByService = indexes.associate { it.service.name to it.service.rootPath }

        return buildString {
            appendLine("Implement the following approved plan exactly.")
            appendLine("For an UPDATE file, the current content is quoted below - edit against that exact text and say what changed.")
            appendLine("For an ADD file, write its full content. For a DELETE, confirm removal and why it's safe.")
            appendLine()
            appendLine("## Plan")
            appendLine("Request: ${plan.request}")
            appendLine("Summary: ${plan.summary}")
            plan.steps.forEach { appendLine("Step: $it") }
            appendLine()
            appendLine("## Files")
            plan.files.forEach { file ->
                appendLine("### ${file.kind} ${file.service}/${file.path}")
                appendLine("Reason: ${file.reason}")
                if (file.kind == ChangeKind.UPDATE) {
                    val root = rootsByService[file.service]
                    val content = root?.let { readFileQuiet(File(it, file.path)) }
                    if (content != null) {
                        appendLine("Current content:")
                        appendLine("```")
                        appendLine(content)
                        appendLine("```")
                    } else {
                        appendLine("(current content not found on disk - this plan may be stale against what's there now; re-check before editing)")
                    }
                }
                appendLine()
            }
        }
    }

    private fun readFileQuiet(file: File): String? = try {
        file.readText()
    } catch (_: Exception) {
        null
    }
}
