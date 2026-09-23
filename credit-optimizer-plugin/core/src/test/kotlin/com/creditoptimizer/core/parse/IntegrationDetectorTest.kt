package com.creditoptimizer.core.parse

import com.creditoptimizer.core.model.DependencyFact
import com.creditoptimizer.core.model.IntegrationCategory
import java.nio.file.Files
import kotlin.io.path.createDirectories
import kotlin.io.path.writeText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class IntegrationDetectorTest {

    private fun tempRepo(vararg files: Pair<String, String>): java.io.File {
        val root = Files.createTempDirectory("integration-detector-")
        for ((relativePath, content) in files) {
            val path = root.resolve(relativePath)
            path.parent.createDirectories()
            path.writeText(content)
        }
        return root.toFile()
    }

    @Test
    fun `detects Oracle from a driver dependency coordinate alone`() {
        val root = tempRepo()
        val deps = listOf(
            DependencyFact("order-service", "pom.xml", "com.oracle.database.jdbc", "ojdbc11", "23.3.0.23.09")
        )
        val facts = IntegrationDetector.detect("order-service", root, deps)
        assertTrue(facts.any { it.name == "Oracle" && it.category == IntegrationCategory.DATASTORE })
    }

    @Test
    fun `detects MongoDB, Kafka and TIBCO EMS from application-yml alone, with no matching dependency`() {
        val root = tempRepo(
            "src/main/resources/application.yml" to """
                spring:
                  data:
                    mongodb:
                      uri: mongodb://localhost:27017/orders
                  kafka:
                    bootstrap-servers: localhost:9092
                tibco:
                  ems:
                    url: tibjmsnaming://localhost:7222
            """.trimIndent()
        )

        val facts = IntegrationDetector.detect("order-service", root, emptyList())
        val names = facts.map { it.name }.toSet()
        assertTrue("MongoDB" in names)
        assertTrue("Kafka" in names)
        assertTrue("TIBCO EMS" in names)
        assertEquals(IntegrationCategory.MESSAGING, facts.first { it.name == "Kafka" }.category)
        assertEquals(IntegrationCategory.DATASTORE, facts.first { it.name == "MongoDB" }.category)
    }

    @Test
    fun `an unrelated dependency and config file yield no integrations`() {
        val root = tempRepo(
            "src/main/resources/application.properties" to "server.port=8080\n"
        )
        val deps = listOf(DependencyFact("order-service", "pom.xml", "org.apache.commons", "commons-lang3", "3.14.0"))
        assertTrue(IntegrationDetector.detect("order-service", root, deps).isEmpty())
    }
}
