package com.copilotarchitect.core

import java.io.File
import java.util.concurrent.TimeUnit

/** The CLI's own floor (see package.json's `engines.node` at the repo root). */
val MINIMUM_NODE_VERSION = NodeVersion(20, 11)

data class NodeVersion(val major: Int, val minor: Int) : Comparable<NodeVersion> {
    override fun compareTo(other: NodeVersion): Int {
        if (major != other.major) return major.compareTo(other.major)
        return minor.compareTo(other.minor)
    }

    override fun toString(): String = "$major.$minor"
}

/** Parses `node --version`'s own output (`v20.11.1`), or `null` if it doesn't look like one. */
fun parseNodeVersion(raw: String): NodeVersion? {
    val match = Regex("""v?(\d+)\.(\d+)""").find(raw.trim()) ?: return null
    val major = match.groupValues[1].toIntOrNull() ?: return null
    val minor = match.groupValues[2].toIntOrNull() ?: return null
    return NodeVersion(major, minor)
}

/** Runs `<node> --version` and parses it, or `null` if the process fails or times out. */
fun readNodeVersion(node: File): NodeVersion? {
    return try {
        val process = ProcessBuilder(node.absolutePath, "--version")
            .redirectErrorStream(true)
            .start()
        val output = process.inputStream.bufferedReader().readText()
        val finished = process.waitFor(10, TimeUnit.SECONDS)
        if (!finished) {
            process.destroyForcibly()
            return null
        }
        parseNodeVersion(output)
    } catch (_: Exception) {
        null
    }
}
