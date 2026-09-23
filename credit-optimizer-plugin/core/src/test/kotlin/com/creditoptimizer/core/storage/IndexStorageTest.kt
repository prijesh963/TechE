package com.creditoptimizer.core.storage

import com.creditoptimizer.core.model.RouteFact
import com.creditoptimizer.core.model.ServiceIndex
import com.creditoptimizer.core.model.ServiceInfo
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class IndexStorageTest {

    @Test
    fun `round-trips a service index through disk`() {
        val root = Files.createTempDirectory("index-storage-").toFile()
        val storage = IndexStorage(root)
        val index = ServiceIndex(
            service = ServiceInfo("payment-service", "/repos/payment-service"),
            routes = listOf(
                RouteFact(
                    service = "payment-service",
                    sourceFile = "PaymentController.java",
                    className = "PaymentController",
                    methodName = "charge",
                    httpMethod = "POST",
                    path = "/payments/{id}/charge"
                )
            ),
            fileHashes = mapOf("PaymentController.java" to "abc123")
        )

        storage.save(index)
        val loaded = storage.load("payment-service")

        assertEquals(index.routes, loaded?.routes)
        assertEquals(index.fileHashes, loaded?.fileHashes)
    }

    @Test
    fun `a service that was never indexed loads as nothing, not an error`() {
        val storage = IndexStorage(Files.createTempDirectory("index-storage-").toFile())
        assertNull(storage.load("never-indexed"))
    }

    @Test
    fun `loadAll returns every stored service`() {
        val storage = IndexStorage(Files.createTempDirectory("index-storage-").toFile())
        storage.save(ServiceIndex(service = ServiceInfo("payment-service", "/repos/payment-service")))
        storage.save(ServiceIndex(service = ServiceInfo("order-service", "/repos/order-service")))

        val all = storage.loadAll().map { it.service.name }.sorted()
        assertEquals(listOf("order-service", "payment-service"), all)
    }
}
