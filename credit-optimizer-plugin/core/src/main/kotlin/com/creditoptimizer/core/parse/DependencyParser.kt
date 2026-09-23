package com.creditoptimizer.core.parse

import com.creditoptimizer.core.model.DependencyFact
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.w3c.dom.Element

/**
 * Extracts declared build dependencies for a whole service repo. Like
 * [JavaServiceParser], this is syntax-level, not a real Maven/Gradle
 * model — but two of its biggest real gaps are handled, not just
 * documented as missing:
 *
 * - **Maven inheritance, pooled rather than chained.** A dependency
 *   omitting `<version>` is resolved against every `pom.xml` in the repo's
 *   own `<dependencyManagement>`, and every `<properties>` block in the
 *   repo is pooled for `${property}` resolution — this is right for the
 *   ordinary "one reactor, one set of parent poms" shape, and only wrong
 *   for a repo that deliberately keeps unrelated POMs whose properties
 *   happen to collide. It is *not* real parent/`relativePath` chain
 *   resolution, and never reaches outside this repo (a real parent POM
 *   published to a registry is invisible to it).
 * - **Gradle version catalogs.** A `libs.xxx.yyy` accessor is resolved
 *   against `gradle/libs.versions.toml` when one exists in the repo.
 *   Still not resolved: a BOM import (`org.springframework.boot:spring-
 *   boot-dependencies` via `platform(...)`), and a catalog alias whose
 *   real Gradle-generated accessor name doesn't match this parser's
 *   dot-to-kebab heuristic.
 */
object DependencyParser {

    /** Back-compat single-file entry point, still used directly by tests exercising one file in isolation. */
    fun parse(service: String, root: File, buildFile: File): List<DependencyFact> = when {
        buildFile.name == "pom.xml" -> {
            val projectEl = parseXmlQuiet(buildFile)
            if (projectEl == null) emptyList() else {
                val properties = propertiesOf(projectEl)
                val managed = managedVersionsOf(projectEl, properties)
                parsePomDependencies(service, root, buildFile, projectEl, properties, managed)
            }
        }
        buildFile.name == "build.gradle" || buildFile.name == "build.gradle.kts" ->
            parseGradleDependencies(service, root, buildFile, versionCatalog = null)
        else -> emptyList()
    }

    /** The real entry point: every build file in the repo, with Maven properties/dependencyManagement and the Gradle version catalog pooled across all of them first. */
    fun parseRepo(service: String, root: File): List<DependencyFact> {
        val buildFiles = findBuildFiles(root)
        val pomFiles = buildFiles.filter { it.name == "pom.xml" }
        val gradleFiles = buildFiles.filter { it.name == "build.gradle" || it.name == "build.gradle.kts" }

        val projectEls = pomFiles.mapNotNull { file -> parseXmlQuiet(file)?.let { file to it } }
        val pooledProperties = projectEls.flatMap { (_, el) -> propertiesOf(el).entries }
            .associate { it.key to it.value }
        val pooledManaged = projectEls.flatMap { (_, el) -> managedVersionsOf(el, pooledProperties).entries }
            .associate { it.key to it.value }

        val versionCatalog = findVersionCatalog(root)?.let { parseVersionCatalog(it) }

        val pomDeps = projectEls.flatMap { (file, el) ->
            parsePomDependencies(service, root, file, el, pooledProperties, pooledManaged)
        }
        val gradleDeps = gradleFiles.flatMap { file ->
            parseGradleDependencies(service, root, file, versionCatalog)
        }
        return pomDeps + gradleDeps
    }

    // --- Maven -------------------------------------------------------------

    private fun parseXmlQuiet(file: File): Element? = try {
        DocumentBuilderFactory.newInstance().apply {
            isNamespaceAware = false
            setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
        }.newDocumentBuilder().parse(file).documentElement
    } catch (_: Exception) {
        null
    }

    private fun propertiesOf(projectEl: Element): Map<String, String> =
        directChildElements(projectEl, "properties")
            .flatMap { it.childElements() }
            .associate { it.tagName to it.textContent.trim() }

    /** groupId:artifactId -> version, from this one POM's own `<dependencyManagement>`. */
    private fun managedVersionsOf(projectEl: Element, properties: Map<String, String>): Map<Pair<String, String>, String> {
        val managementDeps = directChildElements(projectEl, "dependencyManagement")
            .flatMap { directChildElements(it, "dependencies") }
            .flatMap { it.childElements() }
            .filter { it.tagName == "dependency" }

        return managementDeps.mapNotNull { dep ->
            val groupId = dep.childElements().firstOrNull { it.tagName == "groupId" }?.textContent?.trim()
            val artifactId = dep.childElements().firstOrNull { it.tagName == "artifactId" }?.textContent?.trim()
            val rawVersion = dep.childElements().firstOrNull { it.tagName == "version" }?.textContent?.trim()
            if (groupId.isNullOrBlank() || artifactId.isNullOrBlank() || rawVersion.isNullOrBlank()) return@mapNotNull null
            val version = resolveProperty(rawVersion, properties) ?: return@mapNotNull null
            (groupId to artifactId) to version
        }.toMap()
    }

    private fun parsePomDependencies(
        service: String,
        root: File,
        file: File,
        projectEl: Element,
        properties: Map<String, String>,
        managedVersions: Map<Pair<String, String>, String>
    ): List<DependencyFact> {
        val dependenciesEl = directChildElements(projectEl, "dependencies").firstOrNull() ?: return emptyList()
        val relativePath = file.relativeTo(root).path

        return dependenciesEl.childElements()
            .filter { it.tagName == "dependency" }
            .mapNotNull { dep ->
                val groupId = dep.childElements().firstOrNull { it.tagName == "groupId" }?.textContent?.trim()
                val artifactId = dep.childElements().firstOrNull { it.tagName == "artifactId" }?.textContent?.trim()
                if (groupId.isNullOrBlank() || artifactId.isNullOrBlank()) return@mapNotNull null

                val rawVersion = dep.childElements().firstOrNull { it.tagName == "version" }?.textContent?.trim()
                val version = rawVersion?.let { resolveProperty(it, properties) }
                    ?: managedVersions[groupId to artifactId]
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

    /** A `${property}` reference resolved against pooled `<properties>`; a literal passes through unchanged. */
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
    // Groovy and Kotlin DSL quoting. A dependency given via a variable or
    // `project(...)` has no literal coordinate and is not matched.
    private val GRADLE_DEP = Regex(
        """\b(implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|annotationProcessor)""" +
            """\s*\(?\s*["']([\w.\-]+):([\w.\-]+)(?::([\w.\-+]+))?["']"""
    )

    // implementation(libs.spring.boot.starter.web) - a version-catalog accessor.
    private val GRADLE_CATALOG_DEP = Regex(
        """\b(implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|annotationProcessor)""" +
            """\s*\(\s*libs\.([\w.]+)\s*\)"""
    )

    private fun parseGradleDependencies(service: String, root: File, file: File, versionCatalog: VersionCatalog?): List<DependencyFact> {
        val text = try {
            file.readText()
        } catch (_: Exception) {
            return emptyList()
        }
        val relativePath = file.relativeTo(root).path

        val literal = GRADLE_DEP.findAll(text).map { match ->
            DependencyFact(
                service = service,
                sourceFile = relativePath,
                scope = match.groupValues[1],
                groupId = match.groupValues[2],
                artifactId = match.groupValues[3],
                version = match.groupValues[4].ifBlank { null }
            )
        }.toList()

        val fromCatalog = if (versionCatalog == null) emptyList() else GRADLE_CATALOG_DEP.findAll(text).mapNotNull { match ->
            val alias = accessorToAlias(match.groupValues[2])
            val library = versionCatalog.libraries[alias] ?: return@mapNotNull null
            val (groupId, artifactId) = library.coordinates() ?: return@mapNotNull null
            val version = library.version ?: library.versionRef?.let { versionCatalog.versions[it] }
            DependencyFact(
                service = service,
                sourceFile = relativePath,
                scope = match.groupValues[1],
                groupId = groupId,
                artifactId = artifactId,
                version = version
            )
        }.toList()

        return literal + fromCatalog
    }

    /** `libs.spring.boot.starter.web` -> `spring-boot-starter-web`, the common (kebab-alias, dotted-accessor) convention. Not the full Gradle accessor grammar. */
    private fun accessorToAlias(accessorPath: String): String =
        accessorPath.split(".")
            .joinToString("-") { segment -> segment.replace(Regex("([a-z0-9])([A-Z])"), "$1-$2").lowercase() }

    // --- Gradle version catalog (gradle/libs.versions.toml) ------------------

    private data class LibraryRef(
        val groupId: String?,
        val artifactId: String?,
        val module: String?,
        val version: String?,
        val versionRef: String?
    ) {
        fun coordinates(): Pair<String, String>? = when {
            module != null && ":" in module -> module.substringBefore(':') to module.substringAfter(':')
            groupId != null && artifactId != null -> groupId to artifactId
            else -> null
        }
    }

    private data class VersionCatalog(val versions: Map<String, String>, val libraries: Map<String, LibraryRef>)

    private fun findVersionCatalog(root: File): File? =
        findFilesNamed(root, "libs.versions.toml").firstOrNull()

    private val TOML_SECTION = Regex("""^\[(\w+)]$""")
    private val TOML_STRING_ENTRY = Regex("""^([\w.\-]+)\s*=\s*"([^"]*)"\s*$""")
    private val TOML_TABLE_ENTRY = Regex("""^([\w.\-]+)\s*=\s*\{(.+)}\s*$""")
    private val TOML_TABLE_FIELD = Regex("""([\w.]+)\s*=\s*"([^"]*)"""")

    private fun parseVersionCatalog(file: File): VersionCatalog {
        val versions = mutableMapOf<String, String>()
        val libraries = mutableMapOf<String, LibraryRef>()
        var section = ""

        val text = try {
            file.readText()
        } catch (_: Exception) {
            return VersionCatalog(emptyMap(), emptyMap())
        }

        for (rawLine in text.lines()) {
            val line = rawLine.trim()
            TOML_SECTION.find(line)?.let { section = it.groupValues[1]; return@let }
            if (TOML_SECTION.matches(line)) continue

            when (section) {
                "versions" -> TOML_STRING_ENTRY.find(line)?.let { versions[it.groupValues[1]] = it.groupValues[2] }
                "libraries" -> {
                    // group:artifact:version shorthand, e.g. guava = "com.google.guava:guava:31.1-jre"
                    TOML_STRING_ENTRY.find(line)?.let { m ->
                        val parts = m.groupValues[2].split(":")
                        if (parts.size >= 2) {
                            libraries[m.groupValues[1]] = LibraryRef(
                                groupId = parts.getOrNull(0),
                                artifactId = parts.getOrNull(1),
                                module = null,
                                version = parts.getOrNull(2),
                                versionRef = null
                            )
                        }
                    }
                    TOML_TABLE_ENTRY.find(line)?.let { m ->
                        val alias = m.groupValues[1]
                        val fields = TOML_TABLE_FIELD.findAll(m.groupValues[2])
                            .associate { it.groupValues[1] to it.groupValues[2] }
                        libraries[alias] = LibraryRef(
                            groupId = fields["group"],
                            artifactId = fields["name"],
                            module = fields["module"],
                            version = fields["version"],
                            versionRef = fields["version.ref"]
                        )
                    }
                }
            }
        }
        return VersionCatalog(versions, libraries)
    }

    private fun findFilesNamed(root: File, name: String): List<File> {
        if (!root.isDirectory) return emptyList()
        val results = mutableListOf<File>()
        val stack = ArrayDeque<File>()
        stack.add(root)
        while (stack.isNotEmpty()) {
            val dir = stack.removeLast()
            val children = dir.listFiles() ?: continue
            for (child in children) {
                when {
                    child.isDirectory && child.name !in setOf("target", "build", "out", ".git", ".gradle", ".idea", "node_modules") ->
                        stack.add(child)
                    child.isFile && child.name == name -> results.add(child)
                }
            }
        }
        return results
    }
}
