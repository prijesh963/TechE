package com.creditoptimizer.mcp

import com.creditoptimizer.core.IndexService
import com.creditoptimizer.core.handoff.ChangeKind
import com.creditoptimizer.core.handoff.CopilotHandoffService
import com.creditoptimizer.core.handoff.ContextRetrieval
import com.creditoptimizer.core.handoff.PlanStorage
import com.creditoptimizer.core.handoff.PlannedFile
import com.creditoptimizer.core.router.FreePathRouter
import com.creditoptimizer.core.router.RouterResult
import com.creditoptimizer.core.storage.IndexStorage
import io.modelcontextprotocol.kotlin.sdk.types.CallToolResult
import io.modelcontextprotocol.kotlin.sdk.types.Implementation
import io.modelcontextprotocol.kotlin.sdk.types.ServerCapabilities
import io.modelcontextprotocol.kotlin.sdk.types.TextContent
import io.modelcontextprotocol.kotlin.sdk.types.ToolSchema
import io.modelcontextprotocol.kotlin.sdk.server.Server
import io.modelcontextprotocol.kotlin.sdk.server.ServerOptions
import io.modelcontextprotocol.kotlin.sdk.server.StdioServerTransport
import kotlinx.coroutines.runBlocking
import kotlinx.io.asSink
import kotlinx.io.asSource
import kotlinx.io.buffered
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import java.io.File

/** The plan every developer has "in flight" - same convention as the plugin's IndexBridge; no plan-id argument needed. */
private const val CURRENT_PLAN_ID = "current"

/**
 * Exposes [com.creditoptimizer.core.router.FreePathRouter] and
 * [ContextRetrieval] as `ask_index`, and [CopilotHandoffService.recordPlan]
 * as `draft_plan`, so Copilot Chat's own agent loop can call directly into
 * the local index instead of a developer copy/pasting a prompt. Reads and
 * writes the exact same on-disk state (`<project-root>/.idea/creditOptimizer/`)
 * the IntelliJ plugin's Tool Window does - this process never builds the
 * index itself, so there is exactly one indexing path, not two that could
 * disagree, and a plan `draft_plan` records shows up immediately as
 * "Current plan" in the Tool Window.
 *
 * `draft_plan` only ever writes to this project's own plan storage, never
 * to source code, and never sets a plan approved - Approve and Implement
 * stay a human action in the Tool Window regardless of how a draft got
 * recorded. That split is deliberate: Copilot's agent can draft (same risk
 * as answering a question), but nothing here gives it a tool that changes
 * code or approves its own plan on its own initiative.
 */
fun main(args: Array<String>) {
    val projectRoot = args.firstOrNull() ?: error("usage: mcp-server <project-root>")
    val dataDir = File(projectRoot, ".idea/creditOptimizer")
    val indexService = IndexService(IndexStorage(File(dataDir, "index")))
    val planStorage = PlanStorage(File(dataDir, "plans"))

    val server = Server(
        serverInfo = Implementation(name = "credit-optimizer", version = "0.1.0"),
        options = ServerOptions(
            capabilities = ServerCapabilities(
                tools = ServerCapabilities.Tools(listChanged = false)
            )
        )
    )

    server.addTool(
        name = "ask_index",
        description = "Answers a factual question about the indexed Java/Spring Boot microservice repos " +
            "(a route's contract, who consumes a topic, which bean implements an interface, a service's " +
            "dependencies or integrations) directly from the local index. Falls back to the most relevant " +
            "indexed facts when no exact match exists.",
        inputSchema = ToolSchema(
            properties = buildJsonObject {
                put("question", buildJsonObject { put("type", "string") })
            },
            required = listOf("question")
        )
    ) { request ->
        val question = request.arguments?.get("question")?.jsonPrimitive?.content ?: ""
        val indexes = indexService.loadAll()
        val text = when (val result = FreePathRouter.answer(question, indexes)) {
            is RouterResult.LocalAnswer -> "${result.summary}\n\n${result.detail}"
            RouterResult.NeedsGeneration -> {
                val candidates = ContextRetrieval.topCandidates(question, indexes)
                if (candidates.isEmpty()) {
                    "No exact match and no closely related facts found in the index."
                } else {
                    "No exact match in the index. Closest related facts:\n" +
                        candidates.joinToString("\n") { "- [${it.service}/${it.sourceFile}] ${it.text}" }
                }
            }
        }
        CallToolResult(content = listOf(TextContent(text = text)))
    }

    server.addTool(
        name = "draft_plan",
        description = "Records a drafted implementation plan for review in the IntelliJ Tool Window. " +
            "Does NOT write any source file and does NOT approve the plan - a human must click Approve " +
            "and then Copy Implement Prompt in the Tool Window before anything gets written. " +
            "An UPDATE or DELETE naming a file path the local index has never seen for that service is " +
            "silently dropped rather than trusted, so name real files.",
        inputSchema = ToolSchema(
            properties = buildJsonObject {
                put("request", buildJsonObject { put("type", "string") })
                put("summary", buildJsonObject { put("type", "string") })
                put("files", buildJsonObject {
                    put("type", "array")
                    putJsonObject("items") {
                        put("type", "object")
                        putJsonObject("properties") {
                            putJsonObject("service") { put("type", "string") }
                            putJsonObject("path") { put("type", "string") }
                            putJsonObject("kind") {
                                put("type", "string")
                                putJsonArray("enum") {
                                    add(JsonPrimitive("ADD"))
                                    add(JsonPrimitive("UPDATE"))
                                    add(JsonPrimitive("DELETE"))
                                }
                            }
                            putJsonObject("reason") { put("type", "string") }
                        }
                    }
                })
                put("steps", buildJsonObject {
                    put("type", "array")
                    putJsonObject("items") { put("type", "string") }
                })
            },
            required = listOf("request", "summary", "files")
        )
    ) { request ->
        val args = request.arguments
        val requestText = args?.get("request")?.jsonPrimitive?.contentOrNull ?: ""
        val summary = args?.get("summary")?.jsonPrimitive?.contentOrNull ?: ""
        val requestedFiles = args?.get("files")?.jsonArray.orEmpty().mapNotNull { element ->
            val obj = element.jsonObject
            val service = obj["service"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            val path = obj["path"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
            val kind = obj["kind"]?.jsonPrimitive?.contentOrNull?.uppercase()?.let {
                runCatching { ChangeKind.valueOf(it) }.getOrNull()
            } ?: return@mapNotNull null
            val reason = obj["reason"]?.jsonPrimitive?.contentOrNull ?: ""
            PlannedFile(service, path, kind, reason)
        }
        val steps = args?.get("steps")?.jsonArray.orEmpty().mapNotNull { it.jsonPrimitive.contentOrNull }

        val indexes = indexService.loadAll()
        val previous = planStorage.loadLatest(CURRENT_PLAN_ID)
        val plan = CopilotHandoffService.recordPlan(CURRENT_PLAN_ID, requestText, summary, requestedFiles, steps, indexes, previous)
        planStorage.saveRevision(plan)

        val dropped = requestedFiles.size - plan.files.size
        val text = buildString {
            append("Recorded plan revision ${plan.revision} for \"$requestText\" — visible now in the IntelliJ Tool Window's Current plan.\n")
            append("${plan.files.size} file(s) recorded")
            if (dropped > 0) append(", $dropped dropped (named a path the index has never seen)")
            append(".\n")
            append("Not approved and nothing was written. A human must Approve and Copy Implement Prompt in the Tool Window.")
        }
        CallToolResult(content = listOf(TextContent(text = text)))
    }

    val transport = StdioServerTransport(
        inputStream = System.`in`.asSource().buffered(),
        outputStream = System.out.asSink().buffered()
    )

    runBlocking {
        server.createSession(transport)
    }
}
