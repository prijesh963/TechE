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

/**
 * A declared build dependency — from `pom.xml`'s `<dependencies>`, or a
 * Gradle `implementation("group:artifact:version")`-shaped line. [version]
 * is null when it isn't a literal in the build file itself (inherited from
 * a parent POM, a BOM, a Gradle version catalog reference) — never
 * invented.
 */
data class DependencyFact(
    val service: String,
    val sourceFile: String,
    val groupId: String,
    val artifactId: String,
    val version: String? = null,
    /** Maven `<scope>`, or the Gradle configuration name (`implementation`, `testImplementation`, ...). */
    val scope: String? = null
)

/**
 * One method calling another, resolved only as far as syntax allows: the
 * callee's static type comes from a field, a method parameter, or a local
 * variable declared with an explicit type in the same method — an
 * unqualified call is attributed to [callerClass] itself (a same-class or
 * inherited call, not distinguished further). A receiver whose type can't
 * be determined this way is recorded under its raw source text rather
 * than dropped, since even an unresolved receiver name is still real
 * information about what gets called.
 */
data class CallFact(
    val service: String,
    val sourceFile: String,
    val callerClass: String,
    val callerMethod: String,
    val calleeType: String,
    val calleeMethod: String,
    val line: Int
)

/**
 * An outbound HTTP call this service makes — a `RestTemplate`/`WebClient`
 * call whose URI is a literal or same-file constant, or a `@FeignClient`
 * interface's own `@GetMapping`-style method (the call it declares, not a
 * route it exposes — see [BeanFact]'s Spring-Cloud counterpart in the
 * route extractor). This is the other half of a cross-repo HTTP link: a
 * [RouteFact] is what a service exposes, this is what a service calls.
 */
data class HttpClientCallFact(
    val service: String,
    val sourceFile: String,
    val className: String,
    val methodName: String,
    /** Best-effort; "CALL" when the specific verb can't be determined from a generic `exchange(...)`. */
    val httpMethod: String,
    val path: String,
    val line: Int
)

enum class IntegrationCategory { DATASTORE, MESSAGING }

/**
 * A datastore or messaging broker this service is wired to — detected two
 * ways, either of which stands alone: a build dependency coordinate
 * matching a known driver/client (`com.oracle.database.jdbc:ojdbc11`,
 * `org.springframework.kafka:spring-kafka`, `com.tibco:tibjms`, ...), or a
 * connection string/config key found in a Spring config file
 * (`application.yml`/`.properties`, including `application-<profile>`
 * variants) — `jdbc:oracle:`, `mongodb://`, `spring.kafka.*`,
 * `tibco.ems.*`. This is keyword/coordinate matching, not a live
 * connection check: it says the service is *wired for* Oracle/Mongo/Kafka/
 * TIBCO/etc., never that the connection actually works.
 */
data class IntegrationFact(
    val service: String,
    val sourceFile: String,
    val category: IntegrationCategory,
    /** e.g. "Oracle", "MongoDB", "Kafka", "RabbitMQ", "TIBCO EMS". */
    val name: String,
    /** What matched — a dependency coordinate or the config key/URI scheme found. */
    val evidence: String
)

/**
 * A resolved cross-repo edge: [producer] in one service and [consumer] in
 * a *different* service, matched on [MessagingFact.channel] (exact,
 * case-insensitive) and [MessagingFact.broker] — a computed edge, not the
 * name-filter a plain "who consumes X" lookup already did. Computed on
 * demand from the full set of loaded [ServiceIndex]es, not stored in any
 * one of them, since it spans two.
 */
data class MessagingInterlinkFact(
    val producer: MessagingFact,
    val consumer: MessagingFact
)

/** Everything indexed for one service, as one unit that is replaced together on a re-index of that service. */
data class ServiceIndex(
    val service: ServiceInfo,
    val routes: List<RouteFact> = emptyList(),
    val messaging: List<MessagingFact> = emptyList(),
    val beans: List<BeanFact> = emptyList(),
    val symbols: List<SymbolFact> = emptyList(),
    val dependencies: List<DependencyFact> = emptyList(),
    val calls: List<CallFact> = emptyList(),
    val httpClientCalls: List<HttpClientCallFact> = emptyList(),
    val integrations: List<IntegrationFact> = emptyList(),
    /** Relative path -> content hash, for incremental re-indexing and staleness checks. */
    val fileHashes: Map<String, String> = emptyMap(),
    val indexedAtEpochMillis: Long = System.currentTimeMillis()
)
