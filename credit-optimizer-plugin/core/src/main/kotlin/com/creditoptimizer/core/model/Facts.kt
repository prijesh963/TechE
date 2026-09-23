package com.creditoptimizer.core.model

/**
 * The facts the index holds about one Spring Boot microservice repo, and
 * the question the Free-Path Router answers from them without ever
 * involving Copilot. Every fact carries [service] and [sourceFile] so an
 * answer can always say where it came from and be jumped to.
 */

data class ServiceInfo(
    /** A short name for the service — the repo folder's name, unless configured otherwise. */
    val name: String,
    /** Absolute path to the service repo's root on disk. */
    val rootPath: String
)

data class RouteFact(
    val service: String,
    val sourceFile: String,
    val className: String,
    val methodName: String,
    val httpMethod: String,
    /** The full path, base + method-level, e.g. "/orders/{id}/charge". */
    val path: String,
    /** The request body type, if the handler method declares one (e.g. a `@RequestBody` parameter). */
    val requestType: String? = null,
    /** The method's declared return type, unwrapped from `ResponseEntity<T>`/`Mono<T>` where recognizable. */
    val responseType: String? = null
)

enum class MessagingDirection { PRODUCER, CONSUMER }

data class MessagingFact(
    val service: String,
    val sourceFile: String,
    val className: String,
    val methodName: String,
    val direction: MessagingDirection,
    /** Kafka topic or RabbitMQ queue/routing key name, when it resolves to a literal or a named constant. */
    val channel: String,
    val broker: String
)

data class BeanFact(
    val service: String,
    val sourceFile: String,
    /** The interface or supertype other code is wired to, e.g. via `@Autowired`. */
    val contractType: String,
    /** The concrete class annotated `@Service`/`@Component`/`@Repository` that satisfies it. */
    val implementationType: String,
    /** `@Profile`/`@ConditionalOnProperty` value gating this bean, when present — a real disambiguator, not a guess. */
    val condition: String? = null
)

data class SymbolFact(
    val service: String,
    val sourceFile: String,
    val className: String,
    val methodName: String,
    val startLine: Int
)

/** Everything indexed for one service, as one unit that is replaced together on a re-index of that service. */
data class ServiceIndex(
    val service: ServiceInfo,
    val routes: List<RouteFact> = emptyList(),
    val messaging: List<MessagingFact> = emptyList(),
    val beans: List<BeanFact> = emptyList(),
    val symbols: List<SymbolFact> = emptyList(),
    /** Relative path -> content hash, for incremental re-indexing and staleness checks. */
    val fileHashes: Map<String, String> = emptyMap(),
    val indexedAtEpochMillis: Long = System.currentTimeMillis()
)
