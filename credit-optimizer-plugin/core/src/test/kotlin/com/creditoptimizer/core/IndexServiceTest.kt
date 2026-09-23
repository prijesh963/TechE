package com.creditoptimizer.core

import com.creditoptimizer.core.model.ServiceInfo
import com.creditoptimizer.core.storage.IndexStorage
import java.nio.file.Files
import kotlin.io.path.writeText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class IndexServiceTest {

    private fun writeService(name: String, controllerSource: String): ServiceInfo {
        val root = Files.createTempDirectory("$name-")
        root.resolve("Controller.java").writeText(controllerSource)
        return ServiceInfo(name, root.toString())
    }

    @Test
    fun `builds and persists every configured service, then loads them all back`() {
        val storageRoot = Files.createTempDirectory("index-storage-").toFile()
        val service = IndexService(IndexStorage(storageRoot))

        val payment = writeService(
            "payment-service",
            """
                @RestController
                public class PaymentController {
                    @PostMapping("/charge")
                    public String charge() { return "ok"; }
                }
            """.trimIndent()
        )
        val order = writeService(
            "order-service",
            """
                @RestController
                public class OrderController {
                    @GetMapping("/orders")
                    public String list() { return "[]"; }
                }
            """.trimIndent()
        )

        service.buildAll(listOf(payment, order))

        val loaded = service.loadAll().associateBy { it.service.name }
        assertEquals(2, loaded.size)
        assertEquals("/charge", loaded.getValue("payment-service").routes.first().path)
        assertEquals("/orders", loaded.getValue("order-service").routes.first().path)
    }

    @Test
    fun `re-indexing one service does not touch another service's stored index`() {
        val storageRoot = Files.createTempDirectory("index-storage-").toFile()
        val service = IndexService(IndexStorage(storageRoot))

        val payment = writeService(
            "payment-service",
            """
                @RestController
                public class PaymentController {
                    @PostMapping("/charge")
                    public String charge() { return "ok"; }
                }
            """.trimIndent()
        )
        val order = writeService(
            "order-service",
            """
                @RestController
                public class OrderController {
                    @GetMapping("/orders")
                    public String list() { return "[]"; }
                }
            """.trimIndent()
        )
        service.buildAll(listOf(payment, order))

        service.buildOne(payment)

        val orderStillThere = service.loadAll().firstOrNull { it.service.name == "order-service" }
        assertTrue(orderStillThere != null && orderStillThere.routes.isNotEmpty())
    }
}
