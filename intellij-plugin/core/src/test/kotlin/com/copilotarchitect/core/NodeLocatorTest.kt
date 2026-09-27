package com.copilotarchitect.core

import kotlin.test.Test
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class NodeLocatorTest {
    // This sandbox has a real Node on PATH, same as any developer's machine
    // would — a genuine environment check, not a mock.
    @Test
    fun `finds a real, executable Node binary on this machine`() {
        val node = NodeLocator.find()

        assertNotNull(node, "no Node found on PATH — is this sandbox missing one?")
        assertTrue(node.canExecute())

        val version = readNodeVersion(node)
        assertNotNull(version, "found $node but could not read its version")
        assertTrue(version >= MINIMUM_NODE_VERSION, "found Node $version, older than the CLI's floor")
    }
}
