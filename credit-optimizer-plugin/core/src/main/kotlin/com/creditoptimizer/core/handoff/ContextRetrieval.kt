package com.creditoptimizer.core.handoff

import com.creditoptimizer.core.model.ServiceIndex

/**
 * Deterministic keyword-overlap retrieval over everything the index knows
 * — routes, messaging, beans, symbols, dependencies, integrations — used
 * to ground an Ask/Plan prompt with real facts instead of nothing. This is
 * not a guess at the *answer*; it never claims to be. It only picks which
 * already-true facts are worth quoting, by plain word overlap with the
 * question — the reasoning about what those facts mean is left entirely
 * to Copilot, on purpose, matching [com.creditoptimizer.core.router.FreePathRouter]'s
 * own "we retrieve facts, we don't guess at meaning" boundary.
 */
object ContextRetrieval {

    data class Candidate(val service: String, val sourceFile: String, val text: String, val score: Int)

    fun topCandidates(query: String, indexes: List<ServiceIndex>, limit: Int = 12): List<Candidate> {
        val queryWords = tokenize(query)
        if (queryWords.isEmpty()) return emptyList()

        val candidates = mutableListOf<Candidate>()

        for (index in indexes) {
            index.routes.forEach {
                candidates += scored(it.service, it.sourceFile, "${it.httpMethod} ${it.path} — ${it.className}.${it.methodName}", queryWords)
            }
            index.messaging.forEach {
                candidates += scored(it.service, it.sourceFile, "${it.direction} ${it.channel} (${it.broker}) — ${it.className}.${it.methodName}", queryWords)
            }
            index.beans.forEach {
                candidates += scored(it.service, it.sourceFile, "${it.implementationType} implements ${it.contractType}", queryWords)
            }
            index.symbols.forEach {
                candidates += scored(it.service, it.sourceFile, "${it.className}.${it.methodName}()", queryWords)
            }
            index.dependencies.forEach {
                candidates += scored(it.service, it.sourceFile, "depends on ${it.groupId}:${it.artifactId}", queryWords)
            }
            index.integrations.forEach {
                candidates += scored(it.service, it.sourceFile, "${it.category} integration: ${it.name}", queryWords)
            }
        }

        return candidates.filter { it.score > 0 }
            .sortedByDescending { it.score }
            .take(limit)
    }

    private fun scored(service: String, sourceFile: String, text: String, queryWords: Set<String>): Candidate =
        Candidate(service, sourceFile, text, queryWords.intersect(tokenize(text)).size)

    private fun tokenize(text: String): Set<String> =
        text.lowercase().split(Regex("[^a-z0-9]+")).filter { it.length > 2 }.toSet()
}
