package com.copilotarchitect.core

import com.google.gson.JsonParser
import java.io.File
import kotlin.io.path.createTempDirectory
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class McpConfigWriterTest {
    private lateinit var tempDir: File

    @BeforeTest
    fun setUp() {
        tempDir = createTempDirectory("mcp-config-test").toFile()
    }

    @AfterTest
    fun tearDown() {
        tempDir.deleteRecursively()
    }

    @Test
    fun `creates a fresh config file with the copilotArchitect entry`() {
        val configFile = File(tempDir, "nested/mcp.json")

        val result = McpConfigWriter.merge(configFile, "/usr/bin/node", "/opt/copilot-architect/cli.mjs")

        assertTrue(result is McpConfigResult.Written)
        assertTrue(configFile.isFile)

        val root = JsonParser.parseString(configFile.readText()).asJsonObject
        val entry = root.getAsJsonObject("servers").getAsJsonObject("copilotArchitect")
        assertEquals("/usr/bin/node", entry.get("command").asString)
        assertEquals("/opt/copilot-architect/cli.mjs", entry.getAsJsonArray("args")[0].asString)
        assertEquals("mcp", entry.getAsJsonArray("args")[1].asString)
    }

    @Test
    fun `preserves other servers and unrelated keys already in the file`() {
        val configFile = File(tempDir, "mcp.json")
        configFile.writeText(
            """
            {
              "someOtherTopLevelKey": "kept",
              "servers": {
                "github": { "command": "docker", "args": ["run", "ghcr.io/github/github-mcp-server"] }
              }
            }
            """.trimIndent()
        )

        McpConfigWriter.merge(configFile, "/usr/bin/node", "/opt/cli.mjs")

        val root = JsonParser.parseString(configFile.readText()).asJsonObject
        assertEquals("kept", root.get("someOtherTopLevelKey").asString)
        assertTrue(root.getAsJsonObject("servers").has("github"))
        assertTrue(root.getAsJsonObject("servers").has("copilotArchitect"))
    }

    @Test
    fun `re-running merge replaces only the copilotArchitect entry, not the whole file`() {
        val configFile = File(tempDir, "mcp.json")
        McpConfigWriter.merge(configFile, "/usr/bin/node", "/opt/old/cli.mjs")
        configFile.writeText(
            configFile.readText().replace(
                "\"servers\": {",
                "\"servers\": {\n \"other\": {\"command\": \"kept\"},"
            )
        )

        McpConfigWriter.merge(configFile, "/usr/bin/node", "/opt/new/cli.mjs")

        val root = JsonParser.parseString(configFile.readText()).asJsonObject
        val servers = root.getAsJsonObject("servers")
        assertTrue(servers.has("other"))
        assertEquals(
            "/opt/new/cli.mjs",
            servers.getAsJsonObject("copilotArchitect").getAsJsonArray("args")[0].asString
        )
    }

    @Test
    fun `backs up an unparseable existing file rather than discarding it`() {
        val configFile = File(tempDir, "mcp.json")
        configFile.writeText("{ not valid json at all")

        val result = McpConfigWriter.merge(configFile, "/usr/bin/node", "/opt/cli.mjs")

        assertTrue(result is McpConfigResult.Written)
        val backupPath = (result as McpConfigResult.Written).backupPath
        assertTrue(backupPath != null && backupPath.isFile)
        assertEquals("{ not valid json at all", backupPath.readText())
        // The real file now holds a valid, merged config, not the broken one.
        val root = JsonParser.parseString(configFile.readText()).asJsonObject
        assertTrue(root.getAsJsonObject("servers").has("copilotArchitect"))
    }

    @Test
    fun `isConfigured is false when no file exists`() {
        assertFalse(McpConfigWriter.isConfigured(File(tempDir, "missing.json")))
    }

    @Test
    fun `isConfigured is true only after a merge`() {
        val configFile = File(tempDir, "mcp.json")
        assertFalse(McpConfigWriter.isConfigured(configFile))

        McpConfigWriter.merge(configFile, "/usr/bin/node", "/opt/cli.mjs")

        assertTrue(McpConfigWriter.isConfigured(configFile))
    }

    @Test
    fun `resolveConfigPath ends in github-copilot slash intellij slash mcp json`() {
        val path = McpConfigWriter.resolveConfigPath()
        val normalized = path.path.replace(File.separatorChar, '/')
        assertTrue(normalized.endsWith("github-copilot/intellij/mcp.json"), normalized)
    }
}
