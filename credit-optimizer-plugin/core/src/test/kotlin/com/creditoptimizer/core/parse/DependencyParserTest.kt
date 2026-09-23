package com.creditoptimizer.core.parse

import java.nio.file.Files
import kotlin.io.path.createDirectories
import kotlin.io.path.writeText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class DependencyParserTest {

    private fun tempFile(name: String, content: String): java.io.File {
        val dir = Files.createTempDirectory("dep-parser-")
        val path = dir.resolve(name)
        path.writeText(content)
        return path.toFile()
    }

    private fun tempRepo(vararg files: Pair<String, String>): java.io.File {
        val root = Files.createTempDirectory("dep-parser-repo-")
        for ((relativePath, content) in files) {
            val path = root.resolve(relativePath)
            path.parent.createDirectories()
            path.writeText(content)
        }
        return root.toFile()
    }

    @Test
    fun `resolves a Maven dependency's coordinates and scope`() {
        val pom = tempFile(
            "pom.xml",
            """
                <project>
                    <dependencies>
                        <dependency>
                            <groupId>org.springframework.boot</groupId>
                            <artifactId>spring-boot-starter-web</artifactId>
                            <version>3.2.5</version>
                        </dependency>
                        <dependency>
                            <groupId>org.springframework.kafka</groupId>
                            <artifactId>spring-kafka</artifactId>
                            <scope>runtime</scope>
                        </dependency>
                    </dependencies>
                </project>
            """.trimIndent()
        )

        val deps = DependencyParser.parse("payment-service", pom.parentFile, pom)
        assertEquals(2, deps.size)

        val web = deps.first { it.artifactId == "spring-boot-starter-web" }
        assertEquals("org.springframework.boot", web.groupId)
        assertEquals("3.2.5", web.version)

        val kafka = deps.first { it.artifactId == "spring-kafka" }
        assertEquals("runtime", kafka.scope)
        assertNull(kafka.version)
    }

    @Test
    fun `resolves a Maven version given as a property, and leaves an unresolvable one null rather than guessing`() {
        val pom = tempFile(
            "pom.xml",
            """
                <project>
                    <properties>
                        <kafka.version>3.7.0</kafka.version>
                    </properties>
                    <dependencies>
                        <dependency>
                            <groupId>org.apache.kafka</groupId>
                            <artifactId>kafka-clients</artifactId>
                            <version>${'$'}{kafka.version}</version>
                        </dependency>
                        <dependency>
                            <groupId>com.example</groupId>
                            <artifactId>inherited-from-parent</artifactId>
                            <version>${'$'}{parent.managed.version}</version>
                        </dependency>
                    </dependencies>
                </project>
            """.trimIndent()
        )

        val deps = DependencyParser.parse("order-service", pom.parentFile, pom)
        assertEquals("3.7.0", deps.first { it.artifactId == "kafka-clients" }.version)
        assertNull(deps.first { it.artifactId == "inherited-from-parent" }.version)
    }

    @Test
    fun `resolves Gradle Kotlin DSL dependency coordinates`() {
        val build = tempFile(
            "build.gradle.kts",
            """
                dependencies {
                    implementation("org.springframework.boot:spring-boot-starter-web:3.2.5")
                    testImplementation("org.junit.jupiter:junit-jupiter:5.11.0")
                    implementation(project(":core"))
                    implementation(libs.jackson.databind)
                }
            """.trimIndent()
        )

        val deps = DependencyParser.parse("payment-service", build.parentFile, build)
        assertEquals(2, deps.size)

        val web = deps.first { it.artifactId == "spring-boot-starter-web" }
        assertEquals("org.springframework.boot", web.groupId)
        assertEquals("3.2.5", web.version)
        assertEquals("implementation", web.scope)

        val junit = deps.first { it.artifactId == "junit-jupiter" }
        assertEquals("testImplementation", junit.scope)
    }

    @Test
    fun `an unreadable or malformed build file yields no dependencies rather than throwing`() {
        val pom = tempFile("pom.xml", "not even xml <<<")
        assertTrue(DependencyParser.parse("broken-service", pom.parentFile, pom).isEmpty())
    }

    @Test
    fun `parseRepo resolves a child module's version from the parent POM's dependencyManagement, pooled across the repo`() {
        val repo = tempRepo(
            "pom.xml" to """
                <project>
                    <properties>
                        <spring-kafka.version>3.1.2</spring-kafka.version>
                    </properties>
                    <dependencyManagement>
                        <dependencies>
                            <dependency>
                                <groupId>org.springframework.kafka</groupId>
                                <artifactId>spring-kafka</artifactId>
                                <version>${'$'}{spring-kafka.version}</version>
                            </dependency>
                        </dependencies>
                    </dependencyManagement>
                </project>
            """.trimIndent(),
            "order-service/pom.xml" to """
                <project>
                    <dependencies>
                        <dependency>
                            <groupId>org.springframework.kafka</groupId>
                            <artifactId>spring-kafka</artifactId>
                        </dependency>
                    </dependencies>
                </project>
            """.trimIndent()
        )

        val deps = DependencyParser.parseRepo("order-service", repo)
        val kafka = deps.first { it.artifactId == "spring-kafka" }
        assertEquals("3.1.2", kafka.version)
    }

    @Test
    fun `parseRepo resolves a Gradle version-catalog accessor from gradle-libs-versions-toml`() {
        val repo = tempRepo(
            "gradle/libs.versions.toml" to """
                [versions]
                springBoot = "3.2.5"

                [libraries]
                spring-boot-starter-web = { module = "org.springframework.boot:spring-boot-starter-web", version.ref = "springBoot" }
                guava = "com.google.guava:guava:31.1-jre"
            """.trimIndent(),
            "build.gradle.kts" to """
                dependencies {
                    implementation(libs.spring.boot.starter.web)
                    implementation(libs.guava)
                }
            """.trimIndent()
        )

        val deps = DependencyParser.parseRepo("payment-service", repo)
        assertEquals(2, deps.size)

        val web = deps.first { it.artifactId == "spring-boot-starter-web" }
        assertEquals("org.springframework.boot", web.groupId)
        assertEquals("3.2.5", web.version)

        val guava = deps.first { it.artifactId == "guava" }
        assertEquals("com.google.guava", guava.groupId)
        assertEquals("31.1-jre", guava.version)
    }

    @Test
    fun `a version-catalog accessor with no matching alias is dropped, not guessed`() {
        val repo = tempRepo(
            "gradle/libs.versions.toml" to """
                [libraries]
                guava = "com.google.guava:guava:31.1-jre"
            """.trimIndent(),
            "build.gradle.kts" to """
                dependencies {
                    implementation(libs.some.unknown.thing)
                }
            """.trimIndent()
        )

        assertTrue(DependencyParser.parseRepo("payment-service", repo).isEmpty())
    }
}
