package com.creditoptimizer.core.parse

import com.creditoptimizer.core.model.MessagingDirection
import com.creditoptimizer.core.model.ServiceInfo
import java.nio.file.Files
import kotlin.io.path.writeText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class JavaServiceParserTest {

    private fun tempService(vararg files: Pair<String, String>): ServiceInfo {
        val root = Files.createTempDirectory("payment-service-")
        for ((relativePath, content) in files) {
            val path = root.resolve(relativePath)
            Files.createDirectories(path.parent)
            path.writeText(content)
        }
        return ServiceInfo(name = "payment-service", rootPath = root.toString())
    }

    @Test
    fun `resolves a route's HTTP method, combined path, request and response types`() {
        val service = tempService(
            "src/main/java/com/example/payment/PaymentController.java" to """
                package com.example.payment;
                import org.springframework.web.bind.annotation.*;

                @RestController
                @RequestMapping("/payments")
                public class PaymentController {
                    @PostMapping("/{id}/charge")
                    public ResponseEntity<ChargeReceipt> charge(@PathVariable String id, @RequestBody ChargeRequest req) {
                        return null;
                    }
                }
            """.trimIndent()
        )

        val index = JavaServiceParser.parseService(service)

        assertEquals(1, index.routes.size)
        val route = index.routes.first()
        assertEquals("POST", route.httpMethod)
        assertEquals("/payments/{id}/charge", route.path)
        assertEquals("ChargeRequest", route.requestType)
        assertEquals("ChargeReceipt", route.responseType)
        assertEquals("PaymentController", route.className)
        assertEquals("charge", route.methodName)
    }

    @Test
    fun `a class with no @RestController is never mistaken for exposing routes`() {
        val service = tempService(
            "PlainService.java" to """
                public class PlainService {
                    public void doWork() {}
                }
            """.trimIndent()
        )

        val index = JavaServiceParser.parseService(service)
        assertTrue(index.routes.isEmpty())
    }

    @Test
    fun `resolves a Kafka listener topic given as a named constant, not just a literal`() {
        val service = tempService(
            "OrderEventListener.java" to """
                import org.springframework.kafka.annotation.KafkaListener;

                public class OrderEventListener {
                    private static final String ORDER_CREATED_TOPIC = "order.created";

                    @KafkaListener(topics = ORDER_CREATED_TOPIC)
                    public void onOrderCreated(String payload) {}
                }
            """.trimIndent()
        )

        val index = JavaServiceParser.parseService(service)
        assertEquals(1, index.messaging.size)
        val fact = index.messaging.first()
        assertEquals(MessagingDirection.CONSUMER, fact.direction)
        assertEquals("order.created", fact.channel)
        assertEquals("kafka", fact.broker)
    }

    @Test
    fun `resolves a kafkaTemplate send as a producer, and a call built at runtime is dropped not guessed`() {
        val service = tempService(
            "OrderService.java" to """
                public class OrderService {
                    private KafkaTemplate<String, String> kafkaTemplate;

                    public void placeOrder(String dynamicTopic) {
                        kafkaTemplate.send("order.created", "payload");
                        // A value built at runtime is never resolvable, and must not be read as literal text.
                        kafkaTemplate.send(dynamicTopic, "payload");
                    }
                }
            """.trimIndent()
        )

        val index = JavaServiceParser.parseService(service)
        assertEquals(1, index.messaging.size)
        assertEquals("order.created", index.messaging.first().channel)
        assertEquals(MessagingDirection.PRODUCER, index.messaging.first().direction)
    }

    @Test
    fun `resolves a bean's implementation and its @Profile condition`() {
        val service = tempService(
            "SmsNotificationSender.java" to """
                @Service
                @Profile("prod")
                public class SmsNotificationSender implements NotificationSender {
                }
            """.trimIndent()
        )

        val index = JavaServiceParser.parseService(service)
        assertEquals(1, index.beans.size)
        val bean = index.beans.first()
        assertEquals("NotificationSender", bean.contractType)
        assertEquals("SmsNotificationSender", bean.implementationType)
        assertEquals("Profile(prod)", bean.condition)
    }

    @Test
    fun `reuses a previous run's facts for a file whose hash has not changed`() {
        val service = tempService(
            "PaymentController.java" to """
                @RestController
                public class PaymentController {
                    @GetMapping("/health")
                    public String health() { return "ok"; }
                }
            """.trimIndent()
        )

        val first = JavaServiceParser.parseService(service)
        assertEquals(1, first.routes.size)

        // Re-index with the same content: the file's hash is unchanged, so its facts are
        // carried over rather than re-parsed. A corrupt marker planted directly into the
        // "previous" facts proves it was reused, not silently re-derived from the source.
        val markedPrevious = first.copy(routes = first.routes.map { it.copy(className = "ReusedFromCache") })
        val second = JavaServiceParser.parseService(service, previous = markedPrevious)

        assertEquals("ReusedFromCache", second.routes.first().className)
    }

    @Test
    fun `a file with invalid syntax is skipped rather than failing the whole service`() {
        val service = tempService(
            "Broken.java" to "public class Broken { this is not valid java",
            "Good.java" to """
                @RestController
                public class Good {
                    @GetMapping("/ping")
                    public String ping() { return "pong"; }
                }
            """.trimIndent()
        )

        val index = JavaServiceParser.parseService(service)
        assertEquals(1, index.routes.size)
        assertEquals("Good", index.routes.first().className)
    }

    @Test
    fun `every method becomes a symbol fact with its start line`() {
        val service = tempService(
            "Calculator.java" to """
                public class Calculator {
                    public int add(int a, int b) {
                        return a + b;
                    }
                }
            """.trimIndent()
        )

        val index = JavaServiceParser.parseService(service)
        assertEquals(1, index.symbols.size)
        assertEquals("add", index.symbols.first().methodName)
        assertTrue(index.symbols.first().startLine > 0)
    }

    @Test
    fun `an unrecognized send target is never guessed at as a broker`() {
        val service = tempService(
            "Mailer.java" to """
                public class Mailer {
                    public void notify(EmailClient emailClient) {
                        emailClient.send("welcome-email", "payload");
                    }
                }
            """.trimIndent()
        )

        val index = JavaServiceParser.parseService(service)
        assertTrue(index.messaging.isEmpty())
    }

    @Test
    fun `resolves a call through a field, a parameter, a local variable and a for-each loop variable`() {
        val service = tempService(
            "OrderService.java" to """
                public class OrderService {
                    private OrderRepository repo;

                    public void approve(NotificationSender sender) {
                        this.repo.save("x");
                        sender.notify("approved");

                        AuditLog log = new AuditLog();
                        log.record("approved");

                        for (LineItem item : items()) {
                            item.validate();
                        }

                        selfCheck();
                    }

                    private void selfCheck() {}

                    private java.util.List<LineItem> items() { return null; }
                }
            """.trimIndent()
        )

        val index = JavaServiceParser.parseService(service)
        val approveCalls = index.calls.filter { it.callerMethod == "approve" }

        fun calleeOf(method: String) = approveCalls.first { it.calleeMethod == method }.calleeType

        assertEquals("OrderRepository", calleeOf("save"))       // field, reached via this.
        assertEquals("NotificationSender", calleeOf("notify"))  // parameter
        assertEquals("AuditLog", calleeOf("record"))             // local variable
        assertEquals("LineItem", calleeOf("validate"))           // for-each loop variable
        assertEquals("OrderService", calleeOf("selfCheck"))      // unqualified -> same class
    }

    @Test
    fun `a local declared with var has an unresolved callee type, never guessed`() {
        val service = tempService(
            "Thing.java" to """
                public class Thing {
                    public void run() {
                        var helper = newHelper();
                        helper.doWork();
                    }
                    private Helper newHelper() { return null; }
                }
            """.trimIndent()
        )

        val index = JavaServiceParser.parseService(service)
        val call = index.calls.first { it.calleeMethod == "doWork" }
        // Not "Helper" - a var-typed local's real type isn't available without a resolved
        // classpath, so the raw identifier is kept rather than guessed at.
        assertEquals("helper", call.calleeType)
    }

    @Test
    fun `resolves a RestTemplate call's HTTP verb and literal path`() {
        val service = tempService(
            "OrderClient.java" to """
                public class OrderClient {
                    private RestTemplate restTemplate;
                    public void charge(String id) {
                        restTemplate.postForObject("/payments/" + id, null, String.class);
                        restTemplate.getForObject("/orders/{id}", Order.class);
                    }
                }
            """.trimIndent()
        )

        val index = JavaServiceParser.parseService(service)
        // The concatenated path is built at runtime and is dropped, not guessed at.
        assertEquals(1, index.httpClientCalls.size)
        val call = index.httpClientCalls.first()
        assertEquals("GET", call.httpMethod)
        assertEquals("/orders/{id}", call.path)
    }

    @Test
    fun `resolves a WebClient fluent call's verb from its scope chain`() {
        val service = tempService(
            "OrderClient.java" to """
                public class OrderClient {
                    private WebClient webClient;
                    public void fetch() {
                        webClient.get().uri("/orders/{id}").retrieve();
                    }
                }
            """.trimIndent()
        )

        val index = JavaServiceParser.parseService(service)
        assertEquals(1, index.httpClientCalls.size)
        assertEquals("GET", index.httpClientCalls.first().httpMethod)
        assertEquals("/orders/{id}", index.httpClientCalls.first().path)
    }

    @Test
    fun `parseService also picks up the service's own declared build dependencies`() {
        val service = tempService(
            "pom.xml" to """
                <project>
                    <dependencies>
                        <dependency>
                            <groupId>org.springframework.boot</groupId>
                            <artifactId>spring-boot-starter-web</artifactId>
                            <version>3.2.5</version>
                        </dependency>
                    </dependencies>
                </project>
            """.trimIndent(),
            "PlainService.java" to """
                public class PlainService {
                    public void doWork() {}
                }
            """.trimIndent()
        )

        val index = JavaServiceParser.parseService(service)
        assertEquals(1, index.dependencies.size)
        assertEquals("spring-boot-starter-web", index.dependencies.first().artifactId)
    }

    @Test
    fun `a FeignClient interface's own mappings are recorded as calls it makes, not routes it exposes`() {
        val service = tempService(
            "OrderClient.java" to """
                @FeignClient(name = "order-service", path = "/orders")
                public interface OrderClient {
                    @GetMapping("/{id}")
                    Order getOrder(@PathVariable String id);
                }
            """.trimIndent()
        )

        val index = JavaServiceParser.parseService(service)
        assertTrue(index.routes.isEmpty())
        assertEquals(1, index.httpClientCalls.size)
        val call = index.httpClientCalls.first()
        assertEquals("GET", call.httpMethod)
        assertEquals("/orders/{id}", call.path)
        assertEquals("getOrder", call.methodName)
    }
}
