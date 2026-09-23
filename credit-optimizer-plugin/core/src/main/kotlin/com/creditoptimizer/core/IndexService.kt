package com.creditoptimizer.core

import com.creditoptimizer.core.model.ServiceIndex
import com.creditoptimizer.core.model.ServiceInfo
import com.creditoptimizer.core.parse.JavaServiceParser
import com.creditoptimizer.core.storage.IndexStorage

/**
 * Ties discovery, parsing and storage together — the one entry point the
 * IntelliJ plugin module calls. Kept free of any IntelliJ API so it is
 * exercised by plain unit tests (see [com.creditoptimizer.core.IndexServiceTest]),
 * not only by a full IDE test harness this sandbox cannot run anyway.
 */
class IndexService(private val storage: IndexStorage) {

    /** Indexes every configured service, incrementally against what is already stored. */
    fun buildAll(services: List<ServiceInfo>): List<ServiceIndex> =
        services.map { buildOne(it) }

    /** Re-indexes one service, reusing unchanged files' facts from the previous run. */
    fun buildOne(service: ServiceInfo): ServiceIndex {
        val previous = storage.load(service.name)
        val fresh = JavaServiceParser.parseService(service, previous)
        storage.save(fresh)
        return fresh
    }

    fun loadAll(): List<ServiceIndex> = storage.loadAll()
}
