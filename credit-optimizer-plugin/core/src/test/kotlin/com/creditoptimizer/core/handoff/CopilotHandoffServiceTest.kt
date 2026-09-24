package com.creditoptimizer.core.handoff

import com.creditoptimizer.core.model.ServiceIndex
import com.creditoptimizer.core.model.ServiceInfo
import java.nio.file.Files
import kotlin.io.path.writeText
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class CopilotHandoffServiceTest {

    private fun serviceWithFile(name: String, relativePath: String, content: String = "class X {}"): ServiceIndex {
        val root = Files.createTempDirectory("handoff-service-")
        val path = root.resolve(relativePath)
        Files.createDirectories(path.parent)
        path.writeText(content)
        return ServiceIndex(
            service = ServiceInfo(name, root.toString()),
            fileHashes = mapOf(relativePath to "irrelevant-hash")
        )
    }

    @Test
    fun `buildAskPrompt embeds the question and quotes indexed facts`() {
        val index = serviceWithFile("order-service", "OrderController.java")
        val prompt = CopilotHandoffService.buildAskPrompt("what does order-service expose", listOf(index))
        assertTrue("what does order-service expose" in prompt)
        assertTrue("## Question" in prompt)
    }

    @Test
    fun `buildPlanPrompt asks for the fixed SUMMARY-FILE-STEP reply format`() {
        val index = serviceWithFile("order-service", "OrderController.java")
        val prompt = CopilotHandoffService.buildPlanPrompt("add refund support", listOf(index))
        assertTrue("SUMMARY:" in prompt)
        assertTrue("FILE:" in prompt)
        assertTrue("STEP:" in prompt)
        assertTrue("add refund support" in prompt)
    }

    @Test
    fun `importPlan parses summary, files and steps from a pasted reply`() {
        val index = serviceWithFile("order-service", "src/OrderController.java")
        val reply = """
            Some preamble Copilot might add that isn't one of our lines.
            SUMMARY: Add a refund endpoint that reverses a charge.
            FILE: UPDATE order-service/src/OrderController.java — add the refund handler
            FILE: ADD order-service/src/RefundService.java — new service to encapsulate refund logic
            STEP: Add RefundService with a refund(orderId) method.
            STEP: Wire OrderController's new endpoint to call it.
        """.trimIndent()

        val plan = CopilotHandoffService.importPlan("plan-1", "add refund support", reply, listOf(index))

        assertEquals("Add a refund endpoint that reverses a charge.", plan.summary)
        assertEquals(2, plan.files.size)
        assertEquals(2, plan.steps.size)
        assertEquals(1, plan.revision)
        assertFalse(plan.approved)

        val update = plan.files.first { it.kind == ChangeKind.UPDATE }
        assertEquals("src/OrderController.java", update.path)
        val add = plan.files.first { it.kind == ChangeKind.ADD }
        assertEquals("src/RefundService.java", add.path)
    }

    @Test
    fun `importPlan drops an UPDATE naming a path the index has never seen, rather than trusting it`() {
        val index = serviceWithFile("order-service", "src/OrderController.java")
        val reply = """
            SUMMARY: Refund support.
            FILE: UPDATE order-service/src/DoesNotExist.java — this file was invented
        """.trimIndent()

        val plan = CopilotHandoffService.importPlan("plan-1", "add refund support", reply, listOf(index))
        assertTrue(plan.files.isEmpty())
    }

    @Test
    fun `importPlan accepts an ADD to a path that does not exist yet, since that is the point of ADD`() {
        val index = serviceWithFile("order-service", "src/OrderController.java")
        val reply = "FILE: ADD order-service/src/NewFile.java — brand new file"

        val plan = CopilotHandoffService.importPlan("plan-1", "req", reply, listOf(index))
        assertEquals(1, plan.files.size)
    }

    @Test
    fun `re-importing increments the revision from the previous plan`() {
        val index = serviceWithFile("order-service", "src/OrderController.java")
        val first = CopilotHandoffService.importPlan("plan-1", "req", "SUMMARY: v1", listOf(index))
        val second = CopilotHandoffService.importPlan("plan-1", "req", "SUMMARY: v2", listOf(index), previous = first)
        assertEquals(2, second.revision)
    }

    @Test
    fun `buildImplementPrompt refuses a draft plan`() {
        val index = serviceWithFile("order-service", "src/OrderController.java")
        val plan = CopilotHandoffService.importPlan("plan-1", "req", "SUMMARY: x", listOf(index))
        assertNull(CopilotHandoffService.buildImplementPrompt(plan, listOf(index)))
    }

    @Test
    fun `recordPlan saves structured files and steps directly, without parsing any text`() {
        val index = serviceWithFile("order-service", "src/OrderController.java")

        val plan = CopilotHandoffService.recordPlan(
            id = "plan-1",
            request = "add refund support",
            summary = "Add a refund endpoint that reverses a charge.",
            files = listOf(
                PlannedFile("order-service", "src/OrderController.java", ChangeKind.UPDATE, "add the refund handler"),
                PlannedFile("order-service", "src/RefundService.java", ChangeKind.ADD, "new service to encapsulate refund logic")
            ),
            steps = listOf("Add RefundService with a refund(orderId) method.", "Wire OrderController's new endpoint to call it."),
            indexes = listOf(index)
        )

        assertEquals(2, plan.files.size)
        assertEquals(2, plan.steps.size)
        assertEquals(1, plan.revision)
        assertFalse(plan.approved)
    }

    @Test
    fun `recordPlan drops an UPDATE naming a path the index has never seen, same as importPlan`() {
        val index = serviceWithFile("order-service", "src/OrderController.java")

        val plan = CopilotHandoffService.recordPlan(
            id = "plan-1",
            request = "add refund support",
            summary = "x",
            files = listOf(PlannedFile("order-service", "src/DoesNotExist.java", ChangeKind.UPDATE, "invented")),
            steps = emptyList(),
            indexes = listOf(index)
        )

        assertTrue(plan.files.isEmpty())
    }

    @Test
    fun `recordPlan increments the revision from the previous plan, same as importPlan`() {
        val index = serviceWithFile("order-service", "src/OrderController.java")
        val first = CopilotHandoffService.recordPlan("plan-1", "req", "v1", emptyList(), emptyList(), listOf(index))
        val second = CopilotHandoffService.recordPlan("plan-1", "req", "v2", emptyList(), emptyList(), listOf(index), previous = first)
        assertEquals(2, second.revision)
    }

    @Test
    fun `buildImplementPrompt quotes an UPDATE file's real current content`() {
        val index = serviceWithFile("order-service", "src/OrderController.java", content = "public class OrderController { /* real content */ }")
        val draft = CopilotHandoffService.importPlan(
            "plan-1", "req",
            "SUMMARY: x\nFILE: UPDATE order-service/src/OrderController.java — reason",
            listOf(index)
        )
        val approved = CopilotHandoffService.approve(draft)

        val prompt = assertNotNull(CopilotHandoffService.buildImplementPrompt(approved, listOf(index)))
        assertTrue("real content" in prompt)
    }
}
