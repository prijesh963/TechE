package com.creditoptimizer.core.router

import com.creditoptimizer.core.model.BeanFact
import com.creditoptimizer.core.model.CallFact
import com.creditoptimizer.core.model.DependencyFact
import com.creditoptimizer.core.model.HttpClientCallFact
import com.creditoptimizer.core.model.MessagingDirection
import com.creditoptimizer.core.model.MessagingFact
import com.creditoptimizer.core.model.RouteFact
import com.creditoptimizer.core.model.ServiceIndex
import com.creditoptimizer.core.model.ServiceInfo
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue

class FreePathRouterTest {

    private val paymentIndex = ServiceIndex(
        service = ServiceInfo("payment-service", "/repos/payment-service"),
        routes = listOf(
            RouteFact(
                service = "payment-service",
                sourceFile = "PaymentController.java",
                className = "PaymentController",
                methodName = "charge",
                httpMethod = "POST",
                path = "/payments/{id}/charge",
                requestType = "ChargeRequest",
                responseType = "ChargeReceipt"
            )
        ),
        messaging = listOf(
            MessagingFact(
                service = "payment-service",
                sourceFile = "OrderEventListener.java",
                className = "OrderEventListener",
                methodName = "onOrderCreated",
                direction = MessagingDirection.CONSUMER,
                channel = "order.created",
                broker = "kafka"
            )
        ),
        beans = listOf(
            BeanFact(
                service = "payment-service",
                sourceFile = "SmsNotificationSender.java",
                contractType = "NotificationSender",
                implementationType = "SmsNotificationSender",
                condition = "Profile(prod)"
            )
        ),
        dependencies = listOf(
            DependencyFact(
                service = "payment-service",
                sourceFile = "pom.xml",
                groupId = "org.springframework.kafka",
                artifactId = "spring-kafka",
                version = "3.1.2",
                scope = "compile"
            )
        ),
        calls = listOf(
            CallFact(
                service = "payment-service",
                sourceFile = "PaymentController.java",
                callerClass = "PaymentController",
                callerMethod = "charge",
                calleeType = "PaymentService",
                calleeMethod = "process",
                line = 12
            )
        )
    )

    private val orderIndex = ServiceIndex(
        service = ServiceInfo("order-service", "/repos/order-service"),
        httpClientCalls = listOf(
            HttpClientCallFact(
                service = "order-service",
                sourceFile = "PaymentClient.java",
                className = "PaymentClient",
                methodName = "charge",
                httpMethod = "POST",
                path = "/payments/{orderId}/charge",
                line = 8
            )
        )
    )

    @Test
    fun `answers a route contract question directly, with no Copilot involved`() {
        val result = FreePathRouter.answer(
            "what does Payment's /payments/{id}/charge endpoint expect?",
            listOf(paymentIndex)
        )

        val answer = assertIs<RouterResult.LocalAnswer>(result)
        assertTrue("ChargeRequest" in answer.detail)
        assertTrue("ChargeReceipt" in answer.detail)
        assertTrue(answer.sourceFiles.contains("payment-service/PaymentController.java"))
    }

    @Test
    fun `answers who consumes a topic`() {
        val result = FreePathRouter.answer("who consumes the order.created topic?", listOf(paymentIndex))

        val answer = assertIs<RouterResult.LocalAnswer>(result)
        assertTrue("OrderEventListener" in answer.detail)
    }

    @Test
    fun `answers which bean implements an interface, including its condition`() {
        val result = FreePathRouter.answer("which bean implements NotificationSender?", listOf(paymentIndex))

        val answer = assertIs<RouterResult.LocalAnswer>(result)
        assertTrue("SmsNotificationSender" in answer.detail)
        assertTrue("Profile(prod)" in answer.detail)
    }

    @Test
    fun `a generation request falls through to Copilot rather than a wrong local guess`() {
        val result = FreePathRouter.answer("add retry logic to the charge call", listOf(paymentIndex))
        assertEquals(RouterResult.NeedsGeneration, result)
    }

    @Test
    fun `a route question about a path the index does not have falls through, not a wrong nearby match`() {
        val result = FreePathRouter.answer("what does /refunds/{id} expect?", listOf(paymentIndex))
        assertEquals(RouterResult.NeedsGeneration, result)
    }

    @Test
    fun `a route answer lists the cross-repo caller of that route, path variable naming aside`() {
        val result = FreePathRouter.answer(
            "what does Payment's /payments/{id}/charge endpoint expect?",
            listOf(paymentIndex, orderIndex)
        )

        val answer = assertIs<RouterResult.LocalAnswer>(result)
        assertTrue("order-service" in answer.detail)
        assertTrue("PaymentClient" in answer.detail)
        assertTrue(answer.sourceFiles.contains("order-service/PaymentClient.java"))
    }

    @Test
    fun `answers who calls a method`() {
        val result = FreePathRouter.answer("who calls process()?", listOf(paymentIndex))

        val answer = assertIs<RouterResult.LocalAnswer>(result)
        assertTrue("PaymentController" in answer.detail)
        assertTrue("charge" in answer.detail)
    }

    @Test
    fun `answers what a method calls`() {
        val result = FreePathRouter.answer("what does charge() call?", listOf(paymentIndex))

        val answer = assertIs<RouterResult.LocalAnswer>(result)
        assertTrue("PaymentService" in answer.detail)
        assertTrue("process" in answer.detail)
    }

    @Test
    fun `a call-graph question about a method the index does not have falls through`() {
        val result = FreePathRouter.answer("who calls refundEverything()?", listOf(paymentIndex))
        assertEquals(RouterResult.NeedsGeneration, result)
    }

    @Test
    fun `answers a service's dependencies`() {
        val result = FreePathRouter.answer("what does payment-service depend on?", listOf(paymentIndex))

        val answer = assertIs<RouterResult.LocalAnswer>(result)
        assertTrue("spring-kafka" in answer.detail)
        assertTrue("3.1.2" in answer.detail)
    }

    @Test
    fun `answers whether a service depends on a named artifact`() {
        val yes = FreePathRouter.answer("does payment-service depend on kafka?", listOf(paymentIndex))
        assertIs<RouterResult.LocalAnswer>(yes)

        val no = FreePathRouter.answer("does payment-service depend on mongodb?", listOf(paymentIndex))
        assertEquals(RouterResult.NeedsGeneration, no)
    }
}
