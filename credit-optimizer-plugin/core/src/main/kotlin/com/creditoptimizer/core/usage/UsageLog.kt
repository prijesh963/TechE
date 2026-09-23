package com.creditoptimizer.core.usage

import com.fasterxml.jackson.datatype.jsr310.JavaTimeModule
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import java.io.File
import java.time.Instant

enum class UsageKind { INDEX, COPILOT }

data class UsageEntry(
    val question: String,
    val kind: UsageKind,
    val summary: String,
    val at: Instant = Instant.now()
)

/**
 * The one visible way this whole architecture proves it is saving
 * anything: a local, append-only log of every question the Free-Path
 * Router or the Context Composer handled, tagged with which one — so the
 * "how much are we actually saving" answer in the README stops being an
 * estimate and becomes something read back from real use (see the
 * README's "Measuring it for real" section). JSON Lines, one entry per
 * line, so a crash mid-write never corrupts an earlier entry the way a
 * single-JSON-array file would.
 */
class UsageLog(private val file: File) {

    private val mapper = jacksonObjectMapper().apply { registerModule(JavaTimeModule()) }

    fun record(entry: UsageEntry) {
        file.parentFile?.mkdirs()
        file.appendText(mapper.writeValueAsString(entry) + System.lineSeparator())
    }

    /** Most recent first. Malformed lines (a crash mid-write) are skipped, not fatal to the rest. */
    fun recent(limit: Int = 50): List<UsageEntry> {
        if (!file.exists()) return emptyList()
        return file.readLines()
            .asReversed()
            .mapNotNull { line ->
                if (line.isBlank()) null else try {
                    mapper.readValue<UsageEntry>(line)
                } catch (_: Exception) {
                    null
                }
            }
            .take(limit)
    }

    /** [UsageKind.INDEX] entries as a share of everything logged — the number the README's estimate stood in for. */
    fun localAnswerShare(): Double? {
        val all = if (!file.exists()) emptyList() else file.readLines().mapNotNull { line ->
            if (line.isBlank()) null else try {
                mapper.readValue<UsageEntry>(line)
            } catch (_: Exception) {
                null
            }
        }
        if (all.isEmpty()) return null
        return all.count { it.kind == UsageKind.INDEX }.toDouble() / all.size
    }
}
