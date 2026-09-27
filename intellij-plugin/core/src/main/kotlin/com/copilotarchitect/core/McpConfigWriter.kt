package com.copilotarchitect.core

import com.google.gson.GsonBuilder
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.gson.JsonSyntaxException
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date

private const val SERVER_NAME = "copilotArchitect"

private val gson = GsonBuilder().setPrettyPrinting().create()

sealed interface McpConfigResult {
    data class Written(val configPath: File, val backupPath: File?) : McpConfigResult
    data class Failed(val reason: String) : McpConfigResult
}

/**
 * Merges a `copilotArchitect` stdio server entry into GitHub Copilot Chat's
 * MCP configuration.
 *
 * Unlike VS Code's `.vscode/mcp.json` — per-project, and read only when
 * that project is open — JetBrains Copilot Chat reads one global file
 * shared across every project a developer opens
 * (`~/.config/github-copilot/intellij/mcp.json` on Linux/macOS,
 * `%APPDATA%\github-copilot\intellij\mcp.json` on Windows), with no
 * confirmed per-project variable. That is why this writes an absolute path
 * to the bundled CLI rather than anything relative, and why the CLI's own
 * MCP prompts separately tell the model to pass a `path` argument on every
 * tool call instead of relying on this server having been started against
 * the right repo (see docs/KNOWN_LIMITATIONS.md 4.22 in the main
 * repository for what is and is not verified about this).
 */
object McpConfigWriter {
    fun resolveConfigPath(): File {
        val home = System.getProperty("user.home") ?: "."

        return if (isWindows()) {
            val appData = System.getenv("APPDATA") ?: "$home/AppData/Roaming"
            File(appData, "github-copilot/intellij/mcp.json")
        } else {
            File(home, ".config/github-copilot/intellij/mcp.json")
        }
    }

    /**
     * Writes the merged config to [configFile], preserving every other
     * server entry and top-level key untouched.
     *
     * An existing file that fails to parse is backed up rather than
     * silently overwritten or discarded — it may be hand-edited, and a
     * write that destroys it without a trace is worse than one that fails.
     */
    fun merge(configFile: File, nodePath: String, cliPath: String): McpConfigResult {
        val existing = readExisting(configFile)
        val backupPath = existing.corruptRaw?.let { raw -> writeBackup(configFile, raw) }

        val root = existing.parsed ?: JsonObject()
        val servers = root.getAsJsonObject("servers") ?: JsonObject().also { root.add("servers", it) }

        val entry = JsonObject()
        entry.addProperty("command", nodePath)
        val args = com.google.gson.JsonArray()
        args.add(cliPath)
        args.add("mcp")
        entry.add("args", args)
        servers.add(SERVER_NAME, entry)

        return try {
            configFile.parentFile?.mkdirs()
            configFile.writeText(gson.toJson(root) + "\n")
            McpConfigResult.Written(configFile, backupPath)
        } catch (e: Exception) {
            McpConfigResult.Failed("Could not write ${configFile.absolutePath}: ${e.message}")
        }
    }

    /** Whether `servers.copilotArchitect` is already present, without writing anything. */
    fun isConfigured(configFile: File): Boolean {
        val servers = readExisting(configFile).parsed?.getAsJsonObject("servers") ?: return false
        return servers.has(SERVER_NAME)
    }

    private data class ExistingConfig(val parsed: JsonObject?, val corruptRaw: String?)

    private fun readExisting(configFile: File): ExistingConfig {
        if (!configFile.isFile) {
            return ExistingConfig(parsed = null, corruptRaw = null)
        }

        val raw = configFile.readText()
        return try {
            val parsed = JsonParser.parseString(raw)
            if (parsed.isJsonObject) {
                ExistingConfig(parsed = parsed.asJsonObject, corruptRaw = null)
            } else {
                // Valid JSON, but not an object — same treatment as unparseable:
                // there is nothing here safe to merge a `servers` key into.
                ExistingConfig(parsed = null, corruptRaw = raw)
            }
        } catch (_: JsonSyntaxException) {
            ExistingConfig(parsed = null, corruptRaw = raw)
        }
    }

    private fun writeBackup(configFile: File, raw: String): File {
        val stamp = SimpleDateFormat("yyyy-MM-dd'T'HH-mm-ss").format(Date())
        val backup = File(configFile.parentFile, "${configFile.name}.$stamp.bak")
        backup.writeText(raw)
        return backup
    }

    private fun isWindows(): Boolean =
        System.getProperty("os.name")?.lowercase()?.contains("win") == true
}
