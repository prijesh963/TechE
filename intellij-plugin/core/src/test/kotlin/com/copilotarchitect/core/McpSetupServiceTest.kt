package com.copilotarchitect.core

import java.io.File
import kotlin.io.path.createTempDirectory
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertTrue

class McpSetupServiceTest {
    private lateinit var extractionDir: File
    private lateinit var configFile: File

    @BeforeTest
    fun setUp() {
        val tempDir = createTempDirectory("mcp-setup-test").toFile()
        extractionDir = File(tempDir, "extracted")
        configFile = File(tempDir, "mcp.json")
    }

    @AfterTest
    fun tearDown() {
        extractionDir.parentFile.deleteRecursively()
    }

    // Genuinely end to end: the real Node on this machine (this sandbox has
    // one, same as any developer's), fake-but-real classloader resources
    // standing in for the bundled CLI (see CliResourceExtractorTest), and a
    // real config file on disk — every :core decision exercised together,
    // stopping only where the IntelliJ Platform APIs :plugin adds would
    // begin.
    @Test
    fun `finds this machine's real Node, extracts the CLI, and writes the config`() {
        val result = McpSetupService.setup(javaClass.classLoader, extractionDir, configFile)

        assertTrue(result is SetupResult.Success, "setup failed: $result")
        assertTrue(configFile.isFile)
        assertTrue(File(extractionDir, "cli.mjs").isFile)
        assertTrue(McpConfigWriter.isConfigured(configFile))
    }

    @Test
    fun `fails clearly when the CLI bundle was never packaged`() {
        val emptyClassLoader = object : ClassLoader(null) {
            override fun getResourceAsStream(name: String?) = null
        }

        val result = McpSetupService.setup(emptyClassLoader, extractionDir, configFile)

        assertTrue(result is SetupResult.Failed)
        assertTrue((result as SetupResult.Failed).reason.contains("cli.mjs"))
        // Nothing half-written: a failed extraction must not still produce a
        // config pointing at a CLI that was never actually put on disk.
        assertTrue(!configFile.exists())
    }
}
