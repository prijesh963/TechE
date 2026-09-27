package com.copilotarchitect.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class NodeVersionTest {
    @Test
    fun `parses a normal node --version output`() {
        assertEquals(NodeVersion(20, 11), parseNodeVersion("v20.11.1"))
    }

    @Test
    fun `parses without a leading v`() {
        assertEquals(NodeVersion(18, 0), parseNodeVersion("18.0.0"))
    }

    @Test
    fun `tolerates surrounding whitespace`() {
        assertEquals(NodeVersion(20, 11), parseNodeVersion("  v20.11.1\n"))
    }

    @Test
    fun `returns null for output that is not a version`() {
        assertNull(parseNodeVersion("command not found"))
        assertNull(parseNodeVersion(""))
    }

    @Test
    fun `compares by major then minor`() {
        assertTrue(NodeVersion(20, 12) > NodeVersion(20, 11))
        assertTrue(NodeVersion(18, 99) < NodeVersion(20, 0))
        assertEquals(NodeVersion(20, 11), NodeVersion(20, 11))
    }

    @Test
    fun `the CLI's own floor is 20 dot 11`() {
        assertEquals(NodeVersion(20, 11), MINIMUM_NODE_VERSION)
        assertTrue(NodeVersion(20, 10) < MINIMUM_NODE_VERSION)
        assertTrue(NodeVersion(20, 11) >= MINIMUM_NODE_VERSION)
    }
}
