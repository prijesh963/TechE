package com.creditoptimizer.core.parse

import com.creditoptimizer.core.model.DependencyFact
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.w3c.dom.Element

/**
 * Extracts declared build dependencies from a service's own build files.
 * Like [JavaServiceParser], this is syntax-level, not a real Maven/Gradle
 * model: no parent-POM inheritance, no BOM import resolution, no Gradle
 * version-catalog (`libs.spring.boot`) lookup. A dependency whose version
 * isn't a literal in this exact file is still recorded — with
 * `version = null` — rather than dropped, since "this service depends on
 * X" is true information even when the version isn't.
 */
object DependencyParser {

    fun parse(service: String, root: File, buildFile: File): List<DependencyFact> = when {
        buildFile.name == "pom.xml" -> parsePom(service, root, buildFile)
        buildFile.name == "build.gradle" || buildFile.name == "build.gradle.kts" -> parseGradle(service, root, buildFile)
        else -> emptyList()
    }

    // --- Maven -------------------------------------------------------------

    private fun parsePom(service: String, repoRoot: File, file: File): List<DependencyFact> {
        val doc = try {
            DocumentBuilderFactory.newInstance().apply {
                isNamespaceAware = false
                setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
            }.newDocumentBuilder().parse(file)
        } catch (_: Exception) {
            return emptyList()
        }

        val projectEl = doc.documentElement ?: return emptyList()
        val properties = directChildElements(projectEl, "properties")
            .flatMap { it.childElements() }
            .associate { it.tagName to it.textContent.trim() }

        val dependenciesEl = directChildElements(projectEl, "dependencies").firstOrNull() ?: return emptyList()
        val relativePath = file.relativeTo(repoRoot).path

        return dependenciesEl.childElements()
            .filter { it.tagName == "dependency" }
            .mapNotNull { dep ->
                val groupId = dep.childElements().firstOrNull { it.tagName == "groupId" }?.textContent?.trim()
                val artifactId = dep.childElements().firstOrNull { it.tagName == "artifactId" }?.textContent?.trim()
                if (groupId.isNullOrBlank() || artifactId.isNullOrBlank()) return@mapNotNull null

                val rawVersion = dep.childElements().firstOrNull { it.tagName == "version" }?.textContent?.trim()
                val version = rawVersion?.let { resolveProperty(it, properties) }
                val scope = dep.childElements().firstOrNull { it.tagName == "scope" }?.textContent?.trim()

                DependencyFact(
                    service = service,
                    sourceFile = relativePath,
                    groupId = groupId,
                    artifactId = artifactId,
                    version = version,
                    scope = scope
                )
            }
    }

    /** A `${property}` reference resolved against this same POM's `<properties>`; a literal passes through unchanged. */
    private fun resolveProperty(raw: String, properties: Map<String, String>): String? {
        val match = Regex("""^\$\{([^}]+)}$""").find(raw) ?: return raw
        return properties[match.groupValues[1]]
    }

    private fun directChildElements(parent: Element, tag: String): List<Element> =
        parent.childElements().filter { it.tagName == tag }

    private fun Element.childElements(): List<Element> {
        val result = mutableListOf<Element>()
        val children = childNodes
        for (i in 0 until children.length) {
            val node = children.item(i)
            if (node is Element) result += node
        }
        return result
    }

    // --- Gradle --------------------------------------------------------------

    // group:artifact[:version], inside implementation(...)/api(...)/etc, both
    // Groovy and Kotlin DSL quoting. A dependency given via a variable, a
    // version catalog accessor (`libs.spring.boot`), or `project(...)` has no
    // literal coordinate here and is not matched — never guessed at.
    private val GRADLE_DEP = Regex(
        """\b(implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|annotationProcessor)""" +
            """\s*\(?\s*["']([\w.\-]+):([\w.\-]+)(?::([\w.\-+]+))?["']"""
    )

    private fun parseGradle(service: String, repoRoot: File, file: File): List<DependencyFact> {
        val text = try {
            file.readText()
        } catch (_: Exception) {
            return emptyList()
        }
        val relativePath = file.relativeTo(repoRoot).path

        return GRADLE_DEP.findAll(text).map { match ->
            DependencyFact(
                service = service,
                sourceFile = relativePath,
                scope = match.groupValues[1],
                groupId = match.groupValues[2],
                artifactId = match.groupValues[3],
                version = match.groupValues[4].ifBlank { null }
            )
        }.toList()
    }
}
