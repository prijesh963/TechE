package com.creditoptimizer.core.parse

import com.creditoptimizer.core.model.BeanFact
import com.creditoptimizer.core.model.CallFact
import com.creditoptimizer.core.model.DependencyFact
import com.creditoptimizer.core.model.HttpClientCallFact
import com.creditoptimizer.core.model.MessagingDirection
import com.creditoptimizer.core.model.MessagingFact
import com.creditoptimizer.core.model.RouteFact
import com.creditoptimizer.core.model.ServiceIndex
import com.creditoptimizer.core.model.ServiceInfo
import com.creditoptimizer.core.model.SymbolFact
import com.github.javaparser.StaticJavaParser
import com.github.javaparser.ast.CompilationUnit
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration
import com.github.javaparser.ast.body.FieldDeclaration
import com.github.javaparser.ast.body.MethodDeclaration
import com.github.javaparser.ast.expr.AnnotationExpr
import com.github.javaparser.ast.expr.ArrayInitializerExpr
import com.github.javaparser.ast.expr.Expression
import com.github.javaparser.ast.expr.FieldAccessExpr
import com.github.javaparser.ast.expr.MethodCallExpr
import com.github.javaparser.ast.expr.NameExpr
import com.github.javaparser.ast.expr.NormalAnnotationExpr
import com.github.javaparser.ast.expr.SingleMemberAnnotationExpr
import com.github.javaparser.ast.expr.StringLiteralExpr
import com.github.javaparser.ast.expr.ThisExpr
import com.github.javaparser.ast.expr.VariableDeclarationExpr
import com.github.javaparser.ast.stmt.ForEachStmt
import java.io.File

/**
 * Extracts [RouteFact]/[MessagingFact]/[BeanFact]/[SymbolFact] from a
 * service repo's `.java` sources on disk, without a resolved classpath —
 * this is what indexes a *sibling* repo the developer has not opened in
 * IntelliJ, where real PSI resolution is not available (see the README's
 * "PSI vs. JavaParser" note). It is deliberately syntax-level: a named
 * constant is resolved when it is a `String` field in the same file; a
 * value built at runtime, or defined in another file, is left unresolved
 * rather than guessed at — the same "an unresolved reference is dropped,
 * never read as literal text" rule the route/bean/messaging facts all
 * follow.
 *
 * One file that fails to parse (invalid syntax, an unsupported language
 * level) is skipped, not fatal to the whole service — a build tool
 * artifact or a stray fixture file should not blank out a real service's
 * index.
 */
object JavaServiceParser {

    private val HTTP_METHOD_ANNOTATIONS = mapOf(
        "GetMapping" to "GET",
        "PostMapping" to "POST",
        "PutMapping" to "PUT",
        "DeleteMapping" to "DELETE",
        "PatchMapping" to "PATCH"
    )

    private val BEAN_ANNOTATIONS = setOf("Service", "Component", "Repository")
    private val PRODUCER_METHOD_NAMES = setOf("send", "convertAndSend")

    /**
     * Re-indexes [service]. Files whose content hash matches [previous]
     * keep their previously-extracted facts rather than being re-parsed —
     * the incremental update path a save/pull triggers, not a full rebuild.
     */
    fun parseService(service: ServiceInfo, previous: ServiceIndex? = null): ServiceIndex {
        val root = File(service.rootPath)
        val routes = mutableListOf<RouteFact>()
        val messaging = mutableListOf<MessagingFact>()
        val beans = mutableListOf<BeanFact>()
        val symbols = mutableListOf<SymbolFact>()
        val calls = mutableListOf<CallFact>()
        val httpClientCalls = mutableListOf<HttpClientCallFact>()
        val fileHashes = mutableMapOf<String, String>()

        for (file in findJavaFiles(root)) {
            val relativePath = file.relativeTo(root).path
            val hash = sha256Hex(file)
            fileHashes[relativePath] = hash

            val unchanged = previous != null && previous.fileHashes[relativePath] == hash
            if (unchanged) {
                routes += previous.routes.filter { it.sourceFile == relativePath }
                messaging += previous.messaging.filter { it.sourceFile == relativePath }
                beans += previous.beans.filter { it.sourceFile == relativePath }
                symbols += previous.symbols.filter { it.sourceFile == relativePath }
                calls += previous.calls.filter { it.sourceFile == relativePath }
                httpClientCalls += previous.httpClientCalls.filter { it.sourceFile == relativePath }
                continue
            }

            val unit = try {
                StaticJavaParser.parse(file)
            } catch (_: Exception) {
                continue
            }

            for (classDecl in unit.findAll(ClassOrInterfaceDeclaration::class.java)) {
                val className = classDecl.nameAsString
                routes += extractRoutes(unit, classDecl, service.name, relativePath, className)
                messaging += extractConsumers(unit, classDecl, service.name, relativePath, className)
                messaging += extractProducers(unit, classDecl, service.name, relativePath, className)
                beans += extractBeans(unit, classDecl, service.name, relativePath)
                calls += extractCalls(classDecl, service.name, relativePath, className)
                httpClientCalls += extractHttpClientCalls(unit, classDecl, service.name, relativePath, className)

                for (method in classDecl.methods) {
                    val line = method.begin.map { it.line }.orElse(0)
                    symbols += SymbolFact(service.name, relativePath, className, method.nameAsString, line)
                }
            }
        }

        val dependencies = DependencyParser.parseRepo(service.name, root)
        val integrations = IntegrationDetector.detect(service.name, root, dependencies)

        return ServiceIndex(
            service = service,
            routes = routes,
            messaging = messaging,
            beans = beans,
            symbols = symbols,
            dependencies = dependencies,
            calls = calls,
            httpClientCalls = httpClientCalls,
            integrations = integrations,
            fileHashes = fileHashes
        )
    }

    private fun extractRoutes(
        unit: CompilationUnit,
        classDecl: ClassOrInterfaceDeclaration,
        serviceName: String,
        relativePath: String,
        className: String
    ): List<RouteFact> {
        val isController = classDecl.annotations.any {
            it.nameAsString == "RestController" || it.nameAsString == "Controller"
        }
        if (!isController) return emptyList()

        val basePath = classDecl.annotations
            .firstOrNull { it.nameAsString == "RequestMapping" }
            ?.let { annotationPathValue(unit, it) }
            .orEmpty()

        val result = mutableListOf<RouteFact>()
        for (method in classDecl.methods) {
            val mappingAnnotation = method.annotations.firstOrNull {
                it.nameAsString in HTTP_METHOD_ANNOTATIONS || it.nameAsString == "RequestMapping"
            } ?: continue

            val httpMethod = HTTP_METHOD_ANNOTATIONS[mappingAnnotation.nameAsString]
                ?: requestMappingHttpMethod(mappingAnnotation) ?: "REQUEST"
            val methodPath = annotationPathValue(unit, mappingAnnotation).orEmpty()
            val fullPath = joinPaths(basePath, methodPath)

            val requestType = method.parameters
                .firstOrNull { param -> param.annotations.any { it.nameAsString == "RequestBody" } }
                ?.type?.asString()

            result += RouteFact(
                service = serviceName,
                sourceFile = relativePath,
                className = className,
                methodName = method.nameAsString,
                httpMethod = httpMethod,
                path = fullPath,
                requestType = requestType,
                responseType = unwrapResponseType(method.type.asString())
            )
        }
        return result
    }

    private fun extractConsumers(
        unit: CompilationUnit,
        classDecl: ClassOrInterfaceDeclaration,
        serviceName: String,
        relativePath: String,
        className: String
    ): List<MessagingFact> {
        val result = mutableListOf<MessagingFact>()
        for (method in classDecl.methods) {
            val listener = method.annotations.firstOrNull { it.nameAsString == "KafkaListener" } ?: continue
            val topic = (listener as? NormalAnnotationExpr)
                ?.pairs?.firstOrNull { it.nameAsString == "topics" }
                ?.value?.let { firstStringValue(unit, it) }
                ?: continue

            result += MessagingFact(
                service = serviceName,
                sourceFile = relativePath,
                className = className,
                methodName = method.nameAsString,
                direction = MessagingDirection.CONSUMER,
                channel = topic,
                broker = "kafka"
            )
        }
        return result
    }

    private fun extractProducers(
        unit: CompilationUnit,
        classDecl: ClassOrInterfaceDeclaration,
        serviceName: String,
        relativePath: String,
        className: String
    ): List<MessagingFact> {
        val result = mutableListOf<MessagingFact>()
        for (call in classDecl.findAll(MethodCallExpr::class.java)) {
            if (call.nameAsString !in PRODUCER_METHOD_NAMES) continue
            val args = call.arguments
            if (args.isEmpty()) continue
            val channel = resolveStringExpr(unit, args[0]) ?: continue

            val scopeText = call.scope.map { it.toString() }.orElse("")
            val broker = when {
                scopeText.contains("kafka", ignoreCase = true) -> "kafka"
                call.nameAsString == "convertAndSend" -> "rabbitmq"
                else -> continue // an unrecognized target is dropped, not guessed at
            }

            val enclosingMethod = call.findAncestor(MethodDeclaration::class.java).map { it.nameAsString }.orElse("<init>")
            result += MessagingFact(
                service = serviceName,
                sourceFile = relativePath,
                className = className,
                methodName = enclosingMethod,
                direction = MessagingDirection.PRODUCER,
                channel = channel,
                broker = broker
            )
        }
        return result
    }

    private fun extractBeans(
        unit: CompilationUnit,
        classDecl: ClassOrInterfaceDeclaration,
        serviceName: String,
        relativePath: String
    ): List<BeanFact> {
        val isBean = classDecl.annotations.any { it.nameAsString in BEAN_ANNOTATIONS }
        if (!isBean || classDecl.implementedTypes.isEmpty()) return emptyList()

        val condition = classDecl.annotations.firstOrNull {
            it.nameAsString == "Profile" || it.nameAsString == "ConditionalOnProperty"
        }?.let { describeCondition(unit, it) }

        return classDecl.implementedTypes.map { implemented ->
            BeanFact(
                service = serviceName,
                sourceFile = relativePath,
                contractType = implemented.nameAsString,
                implementationType = classDecl.nameAsString,
                condition = condition
            )
        }
    }

    /**
     * Every method call inside [classDecl]'s methods, with the callee's
     * receiver resolved as far as a field/parameter/local-variable/for-each
     * symbol table for that one method allows — see [CallFact]'s own doc
     * for exactly what "resolved" means here. No cross-file, no inherited
     * members, no `var`-inferred local types: those stay unresolved rather
     * than guessed.
     */
    private fun extractCalls(
        classDecl: ClassOrInterfaceDeclaration,
        serviceName: String,
        relativePath: String,
        className: String
    ): List<CallFact> {
        val fieldTypes = classDecl.fields.flatMap { field ->
            field.variables.map { it.nameAsString to simpleTypeName(field.elementType.asString()) }
        }.toMap()

        val result = mutableListOf<CallFact>()
        for (method in classDecl.methods) {
            val body = method.body.orElse(null) ?: continue

            val paramTypes = method.parameters.associate { it.nameAsString to simpleTypeName(it.type.asString()) }

            val localTypes = mutableMapOf<String, String>()
            for (localDecl in body.findAll(VariableDeclarationExpr::class.java)) {
                for (variable in localDecl.variables) {
                    val typeStr = variable.type.asString()
                    if (typeStr != "var") localTypes[variable.nameAsString] = simpleTypeName(typeStr)
                }
            }
            for (forEach in body.findAll(ForEachStmt::class.java)) {
                val variable = forEach.variable.variables.firstOrNull() ?: continue
                val typeStr = variable.type.asString()
                if (typeStr != "var") localTypes[variable.nameAsString] = simpleTypeName(typeStr)
            }

            // Later entries win — a local shadows a same-named parameter, which shadows a same-named field.
            val symbolTable = fieldTypes + paramTypes + localTypes

            for (call in body.findAll(MethodCallExpr::class.java)) {
                val scope = call.scope.orElse(null)
                val calleeType = when {
                    scope == null || scope is ThisExpr -> className
                    scope is NameExpr -> symbolTable[scope.nameAsString] ?: scope.nameAsString
                    scope is FieldAccessExpr -> symbolTable[scope.nameAsString] ?: scope.nameAsString
                    else -> scope.toString().substringAfterLast('.')
                }
                result += CallFact(
                    service = serviceName,
                    sourceFile = relativePath,
                    callerClass = className,
                    callerMethod = method.nameAsString,
                    calleeType = calleeType,
                    calleeMethod = call.nameAsString,
                    line = call.begin.map { it.line }.orElse(0)
                )
            }
        }
        return result
    }

    private val REST_CLIENT_METHODS = mapOf(
        "getForObject" to "GET", "getForEntity" to "GET",
        "postForObject" to "POST", "postForEntity" to "POST",
        "put" to "PUT", "patchForObject" to "PATCH",
        "delete" to "DELETE", "exchange" to "CALL"
    )
    private val WEBCLIENT_VERBS = setOf("get", "post", "put", "delete", "patch")

    /**
     * Outbound calls this class makes: a `RestTemplate`/`WebClient`-shaped
     * call whose path is a literal or same-file constant, and — if
     * [classDecl] is a `@FeignClient` interface — every one of its own
     * `@GetMapping`-style methods, which are calls it declares, never
     * routes it exposes (kept out of [extractRoutes] because a Feign
     * interface is never `@RestController`/`@Controller`).
     */
    private fun extractHttpClientCalls(
        unit: CompilationUnit,
        classDecl: ClassOrInterfaceDeclaration,
        serviceName: String,
        relativePath: String,
        className: String
    ): List<HttpClientCallFact> {
        val result = mutableListOf<HttpClientCallFact>()

        val feignAnnotation = classDecl.annotations.firstOrNull { it.nameAsString == "FeignClient" }
        if (feignAnnotation != null) {
            val basePath = annotationPathValue(unit, feignAnnotation).orEmpty()
            for (method in classDecl.methods) {
                val mapping = method.annotations.firstOrNull {
                    it.nameAsString in HTTP_METHOD_ANNOTATIONS || it.nameAsString == "RequestMapping"
                } ?: continue
                val httpMethod = HTTP_METHOD_ANNOTATIONS[mapping.nameAsString] ?: requestMappingHttpMethod(mapping) ?: "REQUEST"
                val methodPath = annotationPathValue(unit, mapping).orEmpty()
                result += HttpClientCallFact(
                    service = serviceName,
                    sourceFile = relativePath,
                    className = className,
                    methodName = method.nameAsString,
                    httpMethod = httpMethod,
                    path = joinPaths(basePath, methodPath),
                    line = method.begin.map { it.line }.orElse(0)
                )
            }
        }

        for (call in classDecl.findAll(MethodCallExpr::class.java)) {
            val name = call.nameAsString
            val enclosingMethod = { call.findAncestor(MethodDeclaration::class.java).map { it.nameAsString }.orElse("<init>") }

            if (name in REST_CLIENT_METHODS) {
                val path = call.arguments.firstOrNull()?.let { resolveStringExpr(unit, it) } ?: continue
                result += HttpClientCallFact(
                    service = serviceName,
                    sourceFile = relativePath,
                    className = className,
                    methodName = enclosingMethod(),
                    httpMethod = REST_CLIENT_METHODS.getValue(name),
                    path = path,
                    line = call.begin.map { it.line }.orElse(0)
                )
            } else if (name == "uri") {
                val path = call.arguments.firstOrNull()?.let { resolveStringExpr(unit, it) } ?: continue
                val verb = findWebClientVerb(call) ?: continue
                result += HttpClientCallFact(
                    service = serviceName,
                    sourceFile = relativePath,
                    className = className,
                    methodName = enclosingMethod(),
                    httpMethod = verb.uppercase(),
                    path = path,
                    line = call.begin.map { it.line }.orElse(0)
                )
            }
        }
        return result
    }

    /** Walks a fluent call's scope chain (`webClient.get().uri(...)`) for the verb call it hangs off. */
    private fun findWebClientVerb(call: MethodCallExpr): String? {
        var current: Expression? = call.scope.orElse(null)
        var depth = 0
        while (current is MethodCallExpr && depth < 10) {
            if (current.nameAsString.lowercase() in WEBCLIENT_VERBS) return current.nameAsString
            current = current.scope.orElse(null)
            depth++
        }
        return null
    }

    /** Strips generics/varargs/array markers and package qualification down to a bare type name. */
    private fun simpleTypeName(rawType: String): String =
        rawType.removeSuffix("...").replace("[]", "").substringBefore('<').substringAfterLast('.').trim()

    // --- annotation/expression helpers -------------------------------------------------

    private fun annotationPathValue(unit: CompilationUnit, annotation: AnnotationExpr): String? = when (annotation) {
        is SingleMemberAnnotationExpr -> firstStringValue(unit, annotation.memberValue)
        is NormalAnnotationExpr -> annotation.pairs
            .firstOrNull { it.nameAsString == "value" || it.nameAsString == "path" }
            ?.value?.let { firstStringValue(unit, it) }
        else -> null
    }

    private fun requestMappingHttpMethod(annotation: AnnotationExpr): String? {
        val pairs = (annotation as? NormalAnnotationExpr)?.pairs ?: return null
        val methodExpr = pairs.firstOrNull { it.nameAsString == "method" }?.value ?: return null
        // e.g. RequestMethod.GET, or {RequestMethod.GET, RequestMethod.POST} — take the first named constant.
        val text = when (methodExpr) {
            is ArrayInitializerExpr -> methodExpr.values.firstOrNull()?.toString()
            else -> methodExpr.toString()
        } ?: return null
        return text.substringAfterLast('.').trim()
    }

    /** A string value, possibly the first entry of an array-shaped annotation attribute. */
    private fun firstStringValue(unit: CompilationUnit, expr: Expression): String? = when (expr) {
        is ArrayInitializerExpr -> expr.values.firstOrNull()?.let { resolveStringExpr(unit, it) }
        else -> resolveStringExpr(unit, expr)
    }

    /** A literal string, or a same-file `static final String` constant it names — never a runtime-built value. */
    private fun resolveStringExpr(unit: CompilationUnit, expr: Expression): String? = when {
        expr is StringLiteralExpr -> expr.asString()
        expr is NameExpr -> resolveConstant(unit, expr.nameAsString)
        else -> null
    }

    private fun resolveConstant(unit: CompilationUnit, name: String): String? {
        for (field in unit.findAll(FieldDeclaration::class.java)) {
            val variable = field.variables.firstOrNull { it.nameAsString == name } ?: continue
            val initializer = variable.initializer.orElse(null) ?: continue
            if (initializer is StringLiteralExpr) return initializer.asString()
        }
        return null
    }

    private fun describeCondition(unit: CompilationUnit, annotation: AnnotationExpr): String = when (annotation) {
        is SingleMemberAnnotationExpr -> "${annotation.nameAsString}(${firstStringValue(unit, annotation.memberValue) ?: annotation.memberValue})"
        is NormalAnnotationExpr -> "${annotation.nameAsString}(" +
            annotation.pairs.joinToString(", ") { "${it.nameAsString}=${firstStringValue(unit, it.value) ?: it.value}" } +
            ")"
        else -> annotation.nameAsString
    }

    private fun unwrapResponseType(rawType: String): String? {
        if (rawType == "void") return null
        val match = Regex("^(?:ResponseEntity|Mono|Flux)<(.+)>$").find(rawType)
        return (match?.groupValues?.get(1) ?: rawType).trim()
    }

    private fun joinPaths(base: String, method: String): String {
        val left = base.trimEnd('/')
        val right = method.trimStart('/')
        return when {
            left.isEmpty() && right.isEmpty() -> "/"
            right.isEmpty() -> left
            else -> "$left/$right"
        }
    }
}
