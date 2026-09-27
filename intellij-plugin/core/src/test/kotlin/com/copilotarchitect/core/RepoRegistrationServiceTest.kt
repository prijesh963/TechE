package com.copilotarchitect.core

import java.io.File
import kotlin.io.path.createTempDirectory
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class RepoRegistrationServiceTest {
    private lateinit var tempDir: File
    private lateinit var extractionDir: File
    private lateinit var workspaceRoot: File

    @BeforeTest
    fun setUp() {
        tempDir = createTempDirectory("repo-registration-test").toFile()
        extractionDir = File(tempDir, "extracted")
        workspaceRoot = File(tempDir, "workspace").apply { mkdirs() }
    }

    @AfterTest
    fun tearDown() {
        tempDir.deleteRecursively()
    }

    private fun argvLog(): List<String> {
        val log = File(extractionDir, "argv.log")
        return if (log.isFile) log.readLines() else emptyList()
    }

    // Genuinely end to end, the same way McpSetupServiceTest is: this
    // machine's real Node, the fixture cli.mjs under src/test/resources
    // actually spawned and run (not just extracted). The fixture appends its
    // own argv to argv.log in its working directory, which lets this assert
    // the exact command line RepoRegistrationService builds rather than
    // just trusting it did the right thing.
    @Test
    fun `registers each repo with one CLI invocation carrying its own name and path`() {
        val repoA = File(tempDir, "repo-a").apply { mkdirs() }
        val repoB = File(tempDir, "repo-b").apply { mkdirs() }

        val result = RepoRegistrationService.registerRepos(
            javaClass.classLoader,
            extractionDir,
            workspaceRoot,
            listOf(RepoRegistration("repo-a", repoA), RepoRegistration("repo-b", repoB))
        )

        assertTrue(result is RegisterReposResult.Completed, "registration failed: $result")
        val outcomes = (result as RegisterReposResult.Completed).outcomes
        assertEquals(
            listOf("repo-a", "repo-b"),
            outcomes.map { (it as RepoRegistrationOutcome.Registered).name }
        )

        val log = argvLog()
        assertEquals(2, log.size)
        assertEquals(
            """["workspace","add","repo-a","${jsonEscape(repoA.absolutePath)}","--path","${jsonEscape(workspaceRoot.absolutePath)}"]""",
            log[0]
        )
        assertEquals(
            """["workspace","add","repo-b","${jsonEscape(repoB.absolutePath)}","--path","${jsonEscape(workspaceRoot.absolutePath)}"]""",
            log[1]
        )
    }

    @Test
    fun `one repo failing does not stop the others from being registered`() {
        val good = File(tempDir, "good-repo").apply { mkdirs() }
        val bad = File(tempDir, "bad-repo").apply { mkdirs() }

        val result = RepoRegistrationService.registerRepos(
            javaClass.classLoader,
            extractionDir,
            workspaceRoot,
            listOf(
                RepoRegistration("good", good),
                RepoRegistration("FAIL_bad", bad)
            )
        )

        assertTrue(result is RegisterReposResult.Completed, "registration failed: $result")
        val outcomes = (result as RegisterReposResult.Completed).outcomes
        assertTrue(outcomes[0] is RepoRegistrationOutcome.Registered)
        assertTrue(outcomes[1] is RepoRegistrationOutcome.Failed)
        assertTrue((outcomes[1] as RepoRegistrationOutcome.Failed).reason.contains("FAIL_bad"))
    }

    @Test
    fun `refuses with no CLI call at all when nothing was selected`() {
        val result = RepoRegistrationService.registerRepos(
            javaClass.classLoader,
            extractionDir,
            workspaceRoot,
            emptyList()
        )

        assertTrue(result is RegisterReposResult.Failed)
        assertTrue(argvLog().isEmpty())
    }

    @Test
    fun `fails clearly when the CLI bundle was never packaged`() {
        val emptyClassLoader = object : ClassLoader(null) {
            override fun getResourceAsStream(name: String?) = null
        }
        val repo = File(tempDir, "repo").apply { mkdirs() }

        val result = RepoRegistrationService.registerRepos(
            emptyClassLoader,
            extractionDir,
            workspaceRoot,
            listOf(RepoRegistration("repo", repo))
        )

        assertTrue(result is RegisterReposResult.Failed)
        assertTrue((result as RegisterReposResult.Failed).reason.contains("cli.mjs"))
    }

    /** Mirrors `JSON.stringify`'s escaping for the two characters an absolute path could contain. */
    private fun jsonEscape(value: String): String = value.replace("\\", "\\\\").replace("\"", "\\\"")
}
