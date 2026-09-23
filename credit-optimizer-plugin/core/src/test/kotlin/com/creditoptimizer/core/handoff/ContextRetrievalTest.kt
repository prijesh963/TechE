package com.creditoptimizer.core.handoff

import com.creditoptimizer.core.model.RouteFact
import com.creditoptimizer.core.model.ServiceIndex
import com.creditoptimizer.core.model.ServiceInfo
import com.creditoptimizer.core.model.SymbolFact
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ContextRetrievalTest {

    private val index = ServiceIndex(
        service = ServiceInfo("order-service", "/order-service"),
        routes = listOf(
            RouteFact("order-service", "OrderController.java", "OrderController", "charge", "POST", "/orders/{id}/charge")
        ),
        symbols = listOf(
            SymbolFact("order-service", "PaymentValidator.java", "PaymentValidator", "validate", 10),
            SymbolFact("order-service", "InventoryService.java", "InventoryService", "reserveStock", 5)
        )
    )

    @Test
    fun `ranks a fact higher the more question words it shares`() {
        val results = ContextRetrieval.topCandidates("how does order charge validate payment", listOf(index))
        assertTrue(results.isNotEmpty())
        // "validate" and "payment" both appear in PaymentValidator's text; "charge" and "order" in the route.
        assertTrue(results.first().text.contains("PaymentValidator") || results.first().text.contains("charge"))
    }

    @Test
    fun `a fact sharing no words with the question is excluded, not ranked last`() {
        val results = ContextRetrieval.topCandidates("charge payment order validate", listOf(index))
        assertTrue(results.none { it.text.contains("reserveStock") })
    }

    @Test
    fun `an empty or stop-word-only query returns nothing rather than everything`() {
        assertEquals(0, ContextRetrieval.topCandidates("the a of it", listOf(index)).size)
    }
}
