package com.creditoptimizer.mcp

import com.creditoptimizer.core.IndexService
import com.creditoptimizer.core.handoff.ContextRetrieval
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
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File

/**
 * Exposes [com.creditoptimizer.core.router.FreePathRouter] and
 * [ContextRetrieval] as an MCP tool, so Copilot Chat can call directly
 * into the local index instead of a developer copy/pasting a prompt.
 * Reads the same on-disk index the IntelliJ plugin's Reindex button
 * writes (`<project-root>/.idea/creditOptimizer/index/`) - this process
 * never builds the index itself, it only reads what the plugin already
 * built, so there is exactly one indexing path, not two that could
 * disagree.
 *
 * First slice, deliberately scoped: read-only. Plan/Implement over MCP -
 * and the real governance question that raises (should Copilot be able
 * to call a tool that approves its own plan?) - is a follow-up phase, not
 * bundled into this one.
 */
fun main(args: Array<String>) {
    val projectRoot = args.firstOrNull() ?: error("usage: mcp-server <project-root>")
    val indexDir = File(File(projectRoot, ".idea/creditOptimizer"), "index")
    val indexService = IndexService(IndexStorage(indexDir))

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

    val transport = StdioServerTransport(
        inputStream = System.`in`.asSource().buffered(),
        outputStream = System.out.asSink().buffered()
    )

    runBlocking {
        server.createSession(transport)
    }
}
