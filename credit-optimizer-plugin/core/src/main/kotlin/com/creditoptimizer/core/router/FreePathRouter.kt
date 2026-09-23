package com.creditoptimizer.core.router

import com.creditoptimizer.core.model.BeanFact
import com.creditoptimizer.core.model.MessagingDirection
import com.creditoptimizer.core.model.MessagingFact
import com.creditoptimizer.core.model.RouteFact
import com.creditoptimizer.core.model.ServiceIndex
import com.creditoptimizer.core.parse.IntegrationDetector

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
        callGraphAnswer(lower, indexes)?.let { return it }
        dependencyAnswer(lower, indexes)?.let { return it }
        integrationAnswer(lower, indexes)?.let { return it }

        return RouterResult.NeedsGeneration
    }

    private fun routeAnswer(question: String, lower: String, indexes: List<ServiceIndex>): RouterResult? {
        val pathToken = PATH_TOKEN.find(question)?.value ?: return null
        val mentionsContract = listOf("expect", "return", "accept", "response", "request", "endpoint")
            .any { it in lower }
        if (!mentionsContract) return null

        val matches = indexes.flatMap { it.routes }.filter { it.path.contains(pathToken, ignoreCase = true) }
        if (matches.isEmpty()) return null

        val callers = indexes.flatMap { it.httpClientCalls }
            .filter { normalizePathVars(it.path).contains(normalizePathVars(pathToken), ignoreCase = true) }

        val lines = matches.map { route ->
            buildString {
                append("${route.httpMethod} ${route.path} on ${route.service} (${route.className}.${route.methodName})")
                if (route.requestType != null) append("\n  request: ${route.requestType}")
                if (route.responseType != null) append("\n  response: ${route.responseType}")
                val ownCallers = callers.filter { it.service != route.service }
                if (ownCallers.isNotEmpty()) {
                    append("\n  called from:")
                    ownCallers.forEach { caller ->
                        append("\n    ${caller.service} (${caller.className}.${caller.methodName}) — ${caller.httpMethod} ${caller.path}")
                    }
                }
            }
        }
        return RouterResult.LocalAnswer(
            summary = "${matches.size} matching route(s) for $pathToken",
            detail = lines.joinToString("\n\n"),
            sourceFiles = (matches.map { "${it.service}/${it.sourceFile}" } + callers.map { "${it.service}/${it.sourceFile}" }).distinct()
        )
    }

    /** `{id}` vs `{orderId}` are the same path shape — normalize path variables before comparing. */
    private fun normalizePathVars(path: String): String = path.replace(Regex("""\{[^}]*}"""), "{}")

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

        val interlinks = InterlinkResolver.messagingInterlinks(indexes)

        val lines = matches.map { fact: MessagingFact ->
            buildString {
                append("${fact.service} (${fact.className}.${fact.methodName}) — ${fact.broker} — ${fact.channel}")
                val linked = if (askingConsumers) {
                    interlinks.filter { it.consumer == fact }.map { it.producer }
                } else {
                    interlinks.filter { it.producer == fact }.map { it.consumer }
                }
                if (linked.isNotEmpty()) {
                    val verb = if (askingConsumers) "produced by" else "consumed by"
                    append("\n  $verb: " + linked.joinToString(", ") { "${it.service} (${it.className}.${it.methodName})" })
                }
            }
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

    // A bare method reference, required with "()" so a common English word never gets read as a
    // method name — the same "an explicit signal, not a guess" rule every other matcher follows.
    private val METHOD_REF = Regex("""\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\s*\)""")

    private fun callGraphAnswer(lower: String, indexes: List<ServiceIndex>): RouterResult? {
        if ("call" !in lower) return null
        val match = METHOD_REF.find(lower) ?: return null
        val methodName = match.groupValues[1]

        // "who calls X()" (call word before the reference) asks for callers;
        // "what does X() call" (call word after) asks for what X calls.
        val wantCallers = lower.indexOf("call") < match.range.first

        val calls = indexes.flatMap { it.calls }
        val matches = if (wantCallers) {
            calls.filter { it.calleeMethod.equals(methodName, ignoreCase = true) }
        } else {
            calls.filter { it.callerMethod.equals(methodName, ignoreCase = true) }
        }
        if (matches.isEmpty()) return null

        val lines = matches.map { call ->
            if (wantCallers) "${call.service}: ${call.callerClass}.${call.callerMethod}() calls $methodName()"
            else "${call.service}: $methodName() calls ${call.calleeType}.${call.calleeMethod}()"
        }
        val summary = if (wantCallers) "${matches.size} caller(s) of $methodName()" else "${matches.size} call(s) made by $methodName()"
        return RouterResult.LocalAnswer(
            summary = summary,
            detail = lines.distinct().joinToString("\n"),
            sourceFiles = matches.map { "${it.service}/${it.sourceFile}" }.distinct()
        )
    }

    private fun dependencyAnswer(lower: String, indexes: List<ServiceIndex>): RouterResult? {
        if ("depend" !in lower) return null

        val service = indexes.map { it.service.name }.firstOrNull { it.lowercase() in lower }
        val scoped = if (service != null) indexes.filter { it.service.name == service } else indexes
        val deps = scoped.flatMap { it.dependencies }
        if (deps.isEmpty()) return null

        val onIndex = lower.indexOf(" on ")
        val artifactFilter = if (onIndex >= 0) lower.substring(onIndex + 4).trim().trim('?', '.', '!') else null

        val matches = if (!artifactFilter.isNullOrBlank()) {
            deps.filter { it.artifactId.contains(artifactFilter, ignoreCase = true) || it.groupId.contains(artifactFilter, ignoreCase = true) }
        } else {
            deps
        }
        if (matches.isEmpty()) return null

        val lines = matches.distinct().sortedBy { it.artifactId }.map { dep ->
            buildString {
                append("${dep.groupId}:${dep.artifactId}")
                if (dep.version != null) append(":${dep.version}")
                append(" (${dep.service}")
                if (dep.scope != null) append(", ${dep.scope}")
                append(")")
            }
        }
        val summary = if (service != null) "${matches.size} dependenc${if (matches.size == 1) "y" else "ies"} for $service"
            else "${matches.size} dependenc${if (matches.size == 1) "y" else "ies"} across all indexed services"
        return RouterResult.LocalAnswer(
            summary = summary,
            detail = lines.joinToString("\n"),
            sourceFiles = matches.map { "${it.service}/${it.sourceFile}" }.distinct()
        )
    }

    private val INTEGRATION_TRIGGERS = listOf("database", "datastore", "messaging", "broker", "integrat")

    private fun integrationAnswer(lower: String, indexes: List<ServiceIndex>): RouterResult? {
        // A known technology named in the question (even one this service doesn't have) scopes the
        // answer to it - "does X use MongoDB?" must fall through to NeedsGeneration when it doesn't,
        // never quietly list whatever unrelated integrations the service does have.
        val named = IntegrationDetector.KNOWN_NAMES.firstOrNull { it.lowercase() in lower }
        val triggered = named != null || INTEGRATION_TRIGGERS.any { it in lower }
        if (!triggered) return null

        val service = indexes.map { it.service.name }.firstOrNull { it.lowercase() in lower }
        val scoped = if (service != null) indexes.filter { it.service.name == service } else indexes
        val integrations = scoped.flatMap { it.integrations }
        if (integrations.isEmpty()) return null

        val matches = if (named != null) integrations.filter { it.name == named } else integrations
        if (matches.isEmpty()) return null

        val lines = matches.distinctBy { "${it.service}/${it.name}/${it.category}" }
            .sortedBy { "${it.service}/${it.name}" }
            .map { fact -> "${fact.service}: ${fact.name} (${fact.category.name.lowercase()}) — ${fact.evidence} [${fact.sourceFile}]" }

        val summary = if (service != null) "${lines.size} integration(s) for $service"
            else "${lines.size} integration(s) across all indexed services"
        return RouterResult.LocalAnswer(
            summary = summary,
            detail = lines.joinToString("\n"),
            sourceFiles = matches.map { "${it.service}/${it.sourceFile}" }.distinct()
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
