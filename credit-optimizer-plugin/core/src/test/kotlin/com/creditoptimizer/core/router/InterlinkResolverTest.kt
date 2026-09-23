package com.creditoptimizer.core.router

import com.creditoptimizer.core.model.MessagingDirection
import com.creditoptimizer.core.model.MessagingFact
import com.creditoptimizer.core.model.ServiceIndex
import com.creditoptimizer.core.model.ServiceInfo
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class InterlinkResolverTest {

    private fun messaging(service: String, direction: MessagingDirection, channel: String, broker: String = "kafka") =
        MessagingFact(service, "X.java", "X", "handle", direction, channel, broker)

    @Test
    fun `resolves a producer in one service to a consumer in another as a real edge`() {
        val orderIndex = ServiceIndex(
            ServiceInfo("order-service", "/order-service"),
            messaging = listOf(messaging("order-service", MessagingDirection.PRODUCER, "order.created"))
        )
        val paymentIndex = ServiceIndex(
            ServiceInfo("payment-service", "/payment-service"),
            messaging = listOf(messaging("payment-service", MessagingDirection.CONSUMER, "order.created"))
        )

        val links = InterlinkResolver.messagingInterlinks(listOf(orderIndex, paymentIndex))
        assertEquals(1, links.size)
        assertEquals("order-service", links.first().producer.service)
        assertEquals("payment-service", links.first().consumer.service)
    }

    @Test
    fun `a same-service producer and consumer is never reported as a cross-repo link`() {
        val index = ServiceIndex(
            ServiceInfo("order-service", "/order-service"),
            messaging = listOf(
                messaging("order-service", MessagingDirection.PRODUCER, "order.created"),
                messaging("order-service", MessagingDirection.CONSUMER, "order.created")
            )
        )
        assertTrue(InterlinkResolver.messagingInterlinks(listOf(index)).isEmpty())
    }

    @Test
    fun `a different channel name is never linked`() {
        val orderIndex = ServiceIndex(
            ServiceInfo("order-service", "/order-service"),
            messaging = listOf(messaging("order-service", MessagingDirection.PRODUCER, "order.created"))
        )
        val paymentIndex = ServiceIndex(
            ServiceInfo("payment-service", "/payment-service"),
            messaging = listOf(messaging("payment-service", MessagingDirection.CONSUMER, "order.cancelled"))
        )
        assertTrue(InterlinkResolver.messagingInterlinks(listOf(orderIndex, paymentIndex)).isEmpty())
    }

    @Test
    fun `a different broker is never linked even with the same channel name`() {
        val orderIndex = ServiceIndex(
            ServiceInfo("order-service", "/order-service"),
            messaging = listOf(messaging("order-service", MessagingDirection.PRODUCER, "order.created", broker = "kafka"))
        )
        val paymentIndex = ServiceIndex(
            ServiceInfo("payment-service", "/payment-service"),
            messaging = listOf(messaging("payment-service", MessagingDirection.CONSUMER, "order.created", broker = "rabbitmq"))
        )
        assertTrue(InterlinkResolver.messagingInterlinks(listOf(orderIndex, paymentIndex)).isEmpty())
    }
}
