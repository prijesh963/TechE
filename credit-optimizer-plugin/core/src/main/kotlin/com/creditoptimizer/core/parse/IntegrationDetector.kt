package com.creditoptimizer.core.parse

import com.creditoptimizer.core.model.DependencyFact
import com.creditoptimizer.core.model.IntegrationCategory
import com.creditoptimizer.core.model.IntegrationFact
import java.io.File

/**
 * Detects the datastores and messaging brokers a service is wired to, two
 * ways: a build dependency coordinate matching a known driver/client, or a
 * connection string/config key found in a Spring config file. Either one
 * stands alone — a service can show Oracle from its `pom.xml` alone with
 * no `application.yml` in the repo, or vice versa.
 *
 * This is keyword/coordinate matching against a fixed table, not a schema
 * or a live connection: it says the service is *wired for* something,
 * never that the connection actually works, and a real integration this
 * table doesn't name is invisible to it.
 */
object IntegrationDetector {

    private data class Signature(
        val name: String,
        val category: IntegrationCategory,
        /** Matched against `groupId:artifactId`. */
        val dependencyPattern: Regex,
        /** Matched against the raw text of a config file. */
        val configPattern: Regex
    )

    /** Every technology this detector knows how to name — used by the router to tell "asked about X, X isn't there" from "asked generically." */
    val KNOWN_NAMES: List<String> get() = SIGNATURES.map { it.name }

    private val SIGNATURES = listOf(
        Signature("Oracle", IntegrationCategory.DATASTORE, Regex("oracle", RegexOption.IGNORE_CASE), Regex("""jdbc:oracle:""", RegexOption.IGNORE_CASE)),
        Signature("MongoDB", IntegrationCategory.DATASTORE, Regex("mongodb", RegexOption.IGNORE_CASE), Regex("""mongodb(\+srv)?://|spring\.data\.mongodb""", RegexOption.IGNORE_CASE)),
        Signature("PostgreSQL", IntegrationCategory.DATASTORE, Regex("postgresql", RegexOption.IGNORE_CASE), Regex("""jdbc:postgresql:""", RegexOption.IGNORE_CASE)),
        Signature("MySQL", IntegrationCategory.DATASTORE, Regex("mysql", RegexOption.IGNORE_CASE), Regex("""jdbc:mysql:""", RegexOption.IGNORE_CASE)),
        Signature("SQL Server", IntegrationCategory.DATASTORE, Regex("mssql|sqlserver", RegexOption.IGNORE_CASE), Regex("""jdbc:sqlserver:""", RegexOption.IGNORE_CASE)),
        Signature("Redis", IntegrationCategory.DATASTORE, Regex("""(^|[:.])redis([:.]|$)""", RegexOption.IGNORE_CASE), Regex("""spring\.(data\.)?redis""", RegexOption.IGNORE_CASE)),
        Signature("Kafka", IntegrationCategory.MESSAGING, Regex("kafka", RegexOption.IGNORE_CASE), Regex("""spring\.kafka|bootstrap-servers""", RegexOption.IGNORE_CASE)),
        Signature("RabbitMQ", IntegrationCategory.MESSAGING, Regex("amqp|rabbitmq", RegexOption.IGNORE_CASE), Regex("""spring\.rabbitmq""", RegexOption.IGNORE_CASE)),
        Signature("ActiveMQ", IntegrationCategory.MESSAGING, Regex("activemq", RegexOption.IGNORE_CASE), Regex("""spring\.activemq""", RegexOption.IGNORE_CASE)),
        Signature("IBM MQ", IntegrationCategory.MESSAGING, Regex("""com\.ibm\.mq|ibm-mq""", RegexOption.IGNORE_CASE), Regex("""ibm\.mq""", RegexOption.IGNORE_CASE)),
        Signature("TIBCO EMS", IntegrationCategory.MESSAGING, Regex("""tibco|tibjms""", RegexOption.IGNORE_CASE), Regex("""tibco\.ems|tibjmsnaming""", RegexOption.IGNORE_CASE)),
        Signature("TIBCO Rendezvous", IntegrationCategory.MESSAGING, Regex("tibrv", RegexOption.IGNORE_CASE), Regex("""tibco\.rv""", RegexOption.IGNORE_CASE))
    )

    fun detect(service: String, root: File, dependencies: List<DependencyFact>): List<IntegrationFact> {
        val fromDependencies = dependencies.flatMap { dep ->
            val coordinate = "${dep.groupId}:${dep.artifactId}"
            SIGNATURES.filter { it.dependencyPattern.containsMatchIn(coordinate) }
                .map { sig ->
                    IntegrationFact(service, dep.sourceFile, sig.category, sig.name, coordinate)
                }
        }

        val fromConfig = findConfigFiles(root).flatMap { file ->
            val text = try {
                file.readText()
            } catch (_: Exception) {
                return@flatMap emptyList<IntegrationFact>()
            }
            val relativePath = file.relativeTo(root).path
            SIGNATURES.mapNotNull { sig ->
                val match = sig.configPattern.find(text) ?: return@mapNotNull null
                IntegrationFact(service, relativePath, sig.category, sig.name, match.value)
            }
        }

        return (fromDependencies + fromConfig).distinctBy { "${it.name}/${it.sourceFile}/${it.evidence}" }
    }
}
