package com.creditoptimizer.core.storage

import com.creditoptimizer.core.model.ServiceIndex
import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import com.fasterxml.jackson.module.kotlin.readValue
import java.io.File

/**
 * The local, per-developer index — one JSON file per service, gitignored,
 * never shared. Nothing here is silently trusted: a service whose file is
 * missing or unreadable is simply not returned, so a caller sees an empty
 * index rather than a crash, and re-indexing that one service repairs it.
 */
class IndexStorage(private val rootDir: File) {

    private val mapper: ObjectMapper = jacksonObjectMapper()

    init {
        rootDir.mkdirs()
    }

    fun save(index: ServiceIndex) {
        val file = fileFor(index.service.name)
        file.parentFile?.mkdirs()
        mapper.writerWithDefaultPrettyPrinter().writeValue(file, index)
    }

    fun load(serviceName: String): ServiceIndex? {
        val file = fileFor(serviceName)
        if (!file.exists()) return null
        return try {
            mapper.readValue<ServiceIndex>(file)
        } catch (_: Exception) {
            null
        }
    }

    fun loadAll(): List<ServiceIndex> =
        (rootDir.listFiles { f -> f.extension == "json" } ?: emptyArray())
            .mapNotNull { file ->
                try {
                    mapper.readValue<ServiceIndex>(file)
                } catch (_: Exception) {
                    null
                }
            }

    private fun fileFor(serviceName: String): File = File(rootDir, "${sanitize(serviceName)}.json")

    private fun sanitize(name: String): String = name.replace(Regex("[^A-Za-z0-9_-]"), "_")
}
