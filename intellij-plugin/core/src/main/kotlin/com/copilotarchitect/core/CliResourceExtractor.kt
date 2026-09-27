package com.copilotarchitect.core

import java.io.File

/**
 * The bundled CLI's own known layout, produced by `npm run bundle:cli` at
 * the repo root and copied into plugin resources by the `copyCliBundle`
 * Gradle task. Listed explicitly rather than discovered by scanning the
 * classpath — a plugin JAR's resources are not a real filesystem
 * directory `File.listFiles()` can walk.
 */
private val BUNDLED_RESOURCES = listOf(
    "cli.mjs",
    "grammars/tree-sitter.wasm",
    "grammars/tree-sitter-go.wasm",
    "grammars/tree-sitter-rust.wasm"
)

sealed interface CliExtractionResult {
    data class Extracted(val cliPath: File) : CliExtractionResult
    data class Failed(val reason: String) : CliExtractionResult
}

/**
 * Extracts the bundled CLI to a real file on disk.
 *
 * Node cannot execute a script sitting inside a plugin JAR — it needs an
 * actual path — and the indexer resolves its tree-sitter grammars relative
 * to the running script, so the two have to land in the same relative
 * layout they were bundled in, not just the script by itself.
 */
object CliResourceExtractor {
    /** Re-extracted every call, so a plugin update's newer CLI always wins. */
    fun extract(classLoader: ClassLoader, targetDir: File): CliExtractionResult {
        for (resourcePath in BUNDLED_RESOURCES) {
            val resource = classLoader.getResourceAsStream("copilot-architect/$resourcePath")
                ?: return CliExtractionResult.Failed(
                    "Bundled resource copilot-architect/$resourcePath is missing. " +
                        "This build was not packaged with `npm run bundle:cli` first."
                )

            val outFile = File(targetDir, resourcePath)
            try {
                outFile.parentFile?.mkdirs()
                resource.use { input -> outFile.outputStream().use { input.copyTo(it) } }
            } catch (e: Exception) {
                return CliExtractionResult.Failed(
                    "Could not extract $resourcePath to ${outFile.absolutePath}: ${e.message}"
                )
            }
        }

        return CliExtractionResult.Extracted(File(targetDir, "cli.mjs"))
    }
}
