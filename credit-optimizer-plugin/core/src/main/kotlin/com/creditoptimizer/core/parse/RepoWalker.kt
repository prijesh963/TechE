package com.creditoptimizer.core.parse

import java.io.File
import java.security.MessageDigest

/** Directories never worth walking into: build output, VCS metadata, generated code. */
private val IGNORED_DIR_NAMES = setOf(
    "target", "build", "out", ".git", ".gradle", ".idea",
    "node_modules", "generated-sources", "generated"
)

/** Every `.java` file under [root], skipping [IGNORED_DIR_NAMES] at any depth. */
fun findJavaFiles(root: File): List<File> = findFiles(root) { it.name.endsWith(".java") }

/** Every Maven or Gradle build file under [root] — a multi-module repo can have more than one. */
fun findBuildFiles(root: File): List<File> = findFiles(root) {
    it.name == "pom.xml" || it.name == "build.gradle" || it.name == "build.gradle.kts"
}

private val CONFIG_FILE_NAME = Regex("""^application(-[\w.-]+)?\.(yml|yaml|properties)$""")

/** Spring config files: `application.yml`/`.properties` and `application-<profile>` variants, at any depth. */
fun findConfigFiles(root: File): List<File> = findFiles(root) { CONFIG_FILE_NAME.matches(it.name) }

private fun findFiles(root: File, matches: (File) -> Boolean): List<File> {
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
                child.isFile && matches(child) -> results.add(child)
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
