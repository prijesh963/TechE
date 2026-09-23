package com.creditoptimizer.core.router

import com.creditoptimizer.core.model.BeanFact
import com.creditoptimizer.core.model.MessagingDirection
import com.creditoptimizer.core.model.MessagingFact
import com.creditoptimizer.core.model.RouteFact
import com.creditoptimizer.core.model.ServiceIndex

/**
 * Answers a question directly from the local index when it is a plain
 * factual lookup — a route's contract, who else reacts to a topic, which
 * bean actually satisfies an interface — so it never reaches Copilot and
 * never spends a credit. Anything that is not one of these structured
 * shapes returns [RouterResult.NeedsGeneration]: this router does no
 * fuzzy/LLM-like guessing, on purpose — a wrong "free" answer is worse
 * than admitting the question needs Copilot.
 */
object FreePathRouter {

    private val PATH_TOKEN = Regex("""/[\w{}/-]+""")
    private val QUOTED_TOKEN = Regex(""""([^"]+)"|'([^']+)'""")
    // A channel name spoken either "topic order.created" or "the order.created topic" —
    // both are natural phrasings and neither should require the other to fail.
    private val CHANNEL_NEAR_KEYWORD = Regex("""\b(?:topic|queue)\s+([\w.-]+)|\b([\w.-]+)\s+(?:topic|queue)\b""")

    fun answer(question: String, indexes: List<ServiceIndex>): RouterResult {
        val lower = question.lowercase()

        routeAnswer(question, lower, indexes)?.let { return it }
        messagingAnswer(lower, indexes)?.let { return it }
        beanAnswer(lower, indexes)?.let { return it }

        return RouterResult.NeedsGeneration
    }

    private fun routeAnswer(question: String, lower: String, indexes: List<ServiceIndex>): RouterResult? {
        val pathToken = PATH_TOKEN.find(question)?.value ?: return null
        val mentionsContract = listOf("expect", "return", "accept", "response", "request", "endpoint")
            .any { it in lower }
        if (!mentionsContract) return null

        val matches = indexes.flatMap { it.routes }.filter { it.path.contains(pathToken, ignoreCase = true) }
        if (matches.isEmpty()) return null

        val lines = matches.map { route ->
            buildString {
                append("${route.httpMethod} ${route.path} on ${route.service} (${route.className}.${route.methodName})")
                if (route.requestType != null) append("\n  request: ${route.requestType}")
                if (route.responseType != null) append("\n  response: ${route.responseType}")
            }
        }
        return RouterResult.LocalAnswer(
            summary = "${matches.size} matching route(s) for $pathToken",
            detail = lines.joinToString("\n\n"),
            sourceFiles = matches.map { "${it.service}/${it.sourceFile}" }
        )
    }

    private fun messagingAnswer(lower: String, indexes: List<ServiceIndex>): RouterResult? {
        val askingConsumers = "consume" in lower || "listen" in lower || "reacts to" in lower
        val askingProducers = "produce" in lower || "publish" in lower || "sends to" in lower
        if (!askingConsumers && !askingProducers) return null

        val channel = QUOTED_TOKEN.find(lower)?.let { it.groupValues[1].ifEmpty { it.groupValues[2] } }
            ?: CHANNEL_NEAR_KEYWORD.find(lower)?.let { it.groupValues[1].ifEmpty { it.groupValues[2] } }
            ?: return null

        val wantDirection = if (askingConsumers) MessagingDirection.CONSUMER else MessagingDirection.PRODUCER
        val matches = indexes.flatMap { it.messaging }
            .filter { it.direction == wantDirection && it.channel.contains(channel, ignoreCase = true) }
        if (matches.isEmpty()) return null

        val lines = matches.map { fact: MessagingFact ->
            "${fact.service} (${fact.className}.${fact.methodName}) — ${fact.broker} — ${fact.channel}"
        }
        val verb = if (askingConsumers) "Consumer(s)" else "Producer(s)"
        return RouterResult.LocalAnswer(
            summary = "$verb of '$channel'",
            detail = lines.joinToString("\n"),
            sourceFiles = matches.map { "${it.service}/${it.sourceFile}" }
        )
    }

    private fun beanAnswer(lower: String, indexes: List<ServiceIndex>): RouterResult? {
        if ("implement" !in lower && "which bean" !in lower && "what bean" !in lower) return null

        val words = lower.split(Regex("[^A-Za-z0-9]+")).filter { it.isNotBlank() }
        val implementsIndex = words.indexOf("implements").takeIf { it >= 0 }
        val interfaceName = implementsIndex?.let { words.getOrNull(it + 1) } ?: return null

        val matches = indexes.flatMap { it.beans }
            .filter { it.contractType.contains(interfaceName, ignoreCase = true) }
        if (matches.isEmpty()) return null

        val lines = matches.map { bean: BeanFact ->
            buildString {
                append("${bean.implementationType} implements ${bean.contractType} in ${bean.service}")
                if (bean.condition != null) append(" — active when ${bean.condition}")
            }
        }
        return RouterResult.LocalAnswer(
            summary = "${matches.size} implementation(s) of $interfaceName",
            detail = lines.joinToString("\n"),
            sourceFiles = matches.map { "${it.service}/${it.sourceFile}" }
        )
    }
}

sealed interface RouterResult {
    data class LocalAnswer(
        val summary: String,
        val detail: String,
        val sourceFiles: List<String>
    ) : RouterResult

    /** No structured match — this is where the Context Composer/Copilot handoff takes over. */
    data object NeedsGeneration : RouterResult
}
