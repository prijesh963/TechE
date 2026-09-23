package com.creditoptimizer.core.handoff

import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PlanStorageTest {

    private fun storage(): PlanStorage = PlanStorage(Files.createTempDirectory("plan-storage-").toFile())

    private fun plan(id: String, revision: Int, approved: Boolean = false) = FeaturePlan(
        id = id,
        request = "add refund support",
        revision = revision,
        summary = "revision $revision",
        files = emptyList(),
        steps = emptyList(),
        approved = approved
    )

    @Test
    fun `a plan id that was never saved loads as nothing, not an error`() {
        assertNull(storage().loadLatest("never-saved"))
    }

    @Test
    fun `round-trips a saved revision losslessly`() {
        val store = storage()
        store.saveRevision(plan("plan-1", 1))
        val loaded = store.loadLatest("plan-1")
        assertEquals("revision 1", loaded?.summary)
    }

    @Test
    fun `keeps every revision rather than overwriting, and loadLatest picks the highest`() {
        val store = storage()
        store.saveRevision(plan("plan-1", 1))
        store.saveRevision(plan("plan-1", 2))
        store.saveRevision(plan("plan-1", 3, approved = true))

        assertEquals(3, store.loadAll("plan-1").size)
        assertEquals(3, store.loadLatest("plan-1")?.revision)
        assertTrue(store.loadLatest("plan-1")?.approved == true)
    }

    @Test
    fun `re-saving the same revision replaces it rather than duplicating`() {
        val store = storage()
        store.saveRevision(plan("plan-1", 1))
        store.saveRevision(plan("plan-1", 1, approved = true))

        assertEquals(1, store.loadAll("plan-1").size)
        assertTrue(store.loadLatest("plan-1")?.approved == true)
    }

    @Test
    fun `different plan ids do not collide`() {
        val store = storage()
        store.saveRevision(plan("plan-1", 1))
        store.saveRevision(plan("plan-2", 1))

        assertEquals(1, store.loadAll("plan-1").size)
        assertEquals(1, store.loadAll("plan-2").size)
    }
}
