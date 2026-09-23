package com.creditoptimizer.core.parse

import com.creditoptimizer.core.model.BeanFact
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
import com.github.javaparser.ast.expr.MethodCallExpr
import com.github.javaparser.ast.expr.NameExpr
import com.github.javaparser.ast.expr.NormalAnnotationExpr
import com.github.javaparser.ast.expr.SingleMemberAnnotationExpr
import com.github.javaparser.ast.expr.StringLiteralExpr
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

                for (method in classDecl.methods) {
                    val line = method.begin.map { it.line }.orElse(0)
                    symbols += SymbolFact(service.name, relativePath, className, method.nameAsString, line)
                }
            }
        }

        return ServiceIndex(
            service = service,
            routes = routes,
            messaging = messaging,
            beans = beans,
            symbols = symbols,
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
