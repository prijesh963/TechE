package com.copilotarchitect.core

import java.io.File
import kotlin.io.path.createTempDirectory
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class CliResourceExtractorTest {
    private lateinit var tempDir: File

    @BeforeTest
    fun setUp() {
        tempDir = createTempDirectory("cli-extract-test").toFile()
    }

    @AfterTest
    fun tearDown() {
        tempDir.deleteRecursively()
    }

    // Fixtures under src/test/resources/copilot-architect/ stand in for what
    // the real npm run bundle:cli output looks like once copied into plugin
    // resources — same relative layout (cli.mjs beside grammars/*.wasm), just
    // fake content, since the real bundle's own behavior is already verified
    // directly (a live JSON-RPC round-trip against the built dist-cli/cli.mjs).
    @Test
    fun `extracts the CLI and every grammar to matching relative paths`() {
        val result = CliResourceExtractor.extract(javaClass.classLoader, tempDir)

        assertTrue(result is CliExtractionResult.Extracted)
        val cliPath = (result as CliExtractionResult.Extracted).cliPath
        assertEquals(File(tempDir, "cli.mjs"), cliPath)
        assertTrue(cliPath.isFile)
        assertTrue(cliPath.readText().contains("fake cli"))

        for (grammar in listOf("tree-sitter.wasm", "tree-sitter-go.wasm", "tree-sitter-rust.wasm")) {
            assertTrue(File(tempDir, "grammars/$grammar").isFile, "$grammar was not extracted")
        }
    }

    @Test
    fun `fails clearly rather than partially extracting when a resource is missing`() {
        // A classloader with no copilot-architect resources at all — the
        // failure mode of packaging the plugin without running bundle:cli
        // first, which the Gradle task also guards against separately.
        val emptyClassLoader = object : ClassLoader(null) {
            override fun getResourceAsStream(name: String?) = null
        }

        val result = CliResourceExtractor.extract(emptyClassLoader, tempDir)

        assertTrue(result is CliExtractionResult.Failed)
        assertTrue((result as CliExtractionResult.Failed).reason.contains("cli.mjs"))
    }

    @Test
    fun `re-extracting overwrites rather than leaving a stale file behind`() {
        CliResourceExtractor.extract(javaClass.classLoader, tempDir)
        val cliPath = File(tempDir, "cli.mjs")
        cliPath.writeText("stale content from a previous plugin version")

        CliResourceExtractor.extract(javaClass.classLoader, tempDir)

        assertTrue(cliPath.readText().contains("fake cli"))
    }
}
