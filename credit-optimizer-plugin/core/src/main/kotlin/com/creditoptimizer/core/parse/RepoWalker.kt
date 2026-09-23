package com.creditoptimizer.core.parse

import java.io.File
import java.security.MessageDigest

/** Directories never worth walking into: build output, VCS metadata, generated code. */
private val IGNORED_DIR_NAMES = setOf(
    "target", "build", "out", ".git", ".gradle", ".idea",
    "node_modules", "generated-sources", "generated"
)

/** Every `.java` file under [root], skipping [IGNORED_DIR_NAMES] at any depth. */
fun findJavaFiles(root: File): List<File> {
    if (!root.isDirectory) return emptyList()
    val results = mutableListOf<File>()
    val stack = ArrayDeque<File>()
    stack.add(root)

    while (stack.isNotEmpty()) {
        val dir = stack.removeLast()
        val children = dir.listFiles() ?: continue
        for (child in children) {
            when {
                child.isDirectory && child.name !in IGNORED_DIR_NAMES -> stack.add(child)
                child.isFile && child.name.endsWith(".java") -> results.add(child)
            }
        }
    }
    return results
}

/** SHA-256 of a file's bytes, hex-encoded — the staleness key ([com.creditoptimizer.core.model.ServiceIndex.fileHashes]). */
fun sha256Hex(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    val bytes = digest.digest(file.readBytes())
    return bytes.joinToString("") { "%02x".format(it) }
}
