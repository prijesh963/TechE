import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AgentService } from "../packages/agents/src/index.js";

describe("AgentService", () => {
  it("lists the required custom Copilot agents", () => {
    const templates = new AgentService().list().templates;

    expect(templates.map((template) => template.name)).toEqual([
      "FeatureArchitect",
      "FeatureImplementer",
      "CodeReviewer",
      "TestPlanner",
      "Debugger",
      "SecurityReviewer",
      "PerformanceReviewer",
      "DocumentationWriter",
      "DependencyAuditor",
      "APIDesignReviewer",
      "CodeAnalysisAgent"
    ]);
  });

  it("gives CodeAnalysisAgent a way to enumerate the repo without guessing", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-agents-analysis-"));
    await new AgentService().install({ startPath: repoRoot });
    const agent = await readFile(
      path.join(repoRoot, ".github/agents/CodeAnalysisAgent.agent.md"),
      "utf8"
    );

    // Regression: the agent could only reach the index through keyword
    // search, so on a Java repo it guessed "main"/"app"/"server", matched
    // nothing, and fell back to whatever file was open in the editor.
    expect(agent).toContain("list_repo_files");
    expect(agent).toContain("MANDATORY INVENTORY");
    expect(agent).toContain("Zero search hits mean the query missed");
    // The old instruction to guess keywords is gone. The same words now
    // survive only inside the warning explaining why guessing fails, so
    // assert on the instruction rather than on the words themselves.
    expect(agent).not.toContain("Call `search_repo` with entry-point keywords");
    expect(agent).toContain("terms taken FROM THE INVENTORY");
  });

  it("wires the agents into the specified orchestration graph", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-agents-graph-"));
    await new AgentService().install({ startPath: repoRoot });

    const handoffsOf = async (agent: string): Promise<string[]> => {
      const text = await readFile(
        path.join(repoRoot, ".github/agents", `${agent}.agent.md`),
        "utf8"
      );
      return [...text.matchAll(/^ {4}agent: (\w+)$/gm)].map((match) => match[1]);
    };

    // Planner → Implementer → Reviewer, with the reviewer looping accepted
    // findings back to the planner or moving forward to unit tests.
    expect(await handoffsOf("FeatureArchitect")).toEqual(["FeatureImplementer"]);
    expect(await handoffsOf("FeatureImplementer")).toEqual(["CodeReviewer"]);
    expect(await handoffsOf("CodeReviewer")).toEqual([
      "FeatureArchitect",
      "TestPlanner"
    ]);

    // Standalone by design: analysis reports and suggests but never routes,
    // and the flow no longer exits into the debugger.
    expect(await handoffsOf("CodeAnalysisAgent")).toEqual([]);
    expect(await handoffsOf("TestPlanner")).toEqual([]);
    expect(await handoffsOf("Debugger")).toEqual([]);
  });

  it("rejects an agent file that breaks the orchestration contract", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-agents-contract-"));
    const service = new AgentService();
    await service.install({ startPath: repoRoot });

    const analysisPath = path.join(
      repoRoot,
      ".github/agents/CodeAnalysisAgent.agent.md"
    );
    const original = await readFile(analysisPath, "utf8");
    // Re-introducing a handoff on the standalone analysis agent must fail
    // validation rather than silently changing the flow.
    await writeFile(
      analysisPath,
      original.replace(
        "tools:",
        "handoffs:\n  - label: Plan a Feature\n    agent: FeatureArchitect\ntools:"
      ),
      "utf8"
    );

    const validation = await service.validate({ startPath: repoRoot });

    expect(validation.ok).toBe(false);
    expect(JSON.stringify(validation)).toContain("standalone");
  });

  it("installs and validates agent files under .github/agents", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-agents-install-"));
    const service = new AgentService();

    const install = await service.install({ startPath: repoRoot });
    const validation = await service.validate({ startPath: repoRoot });
    const featureArchitectPath = path.join(
      repoRoot,
      ".github/agents/FeatureArchitect.agent.md"
    );
    const featureArchitect = await readFile(featureArchitectPath, "utf8");

    expect(install.results).toHaveLength(11);
    expect(install.results.every((result) => result.status === "installed")).toBe(true);
    expect(validation.ok).toBe(true);
    expect(featureArchitect).toContain("---\nname: FeatureArchitect");
    expect(featureArchitect).toContain("copilotArchitect/*");
    expect(featureArchitect).toContain("handoffs:");
    expect(featureArchitect).toContain("agent: FeatureImplementer");
    expect(featureArchitect).toContain("## Safety Rules");
    expect(featureArchitect).toContain(".copilot-architect/plans/latest-plan.md");
  });

  it("supports dry-run without writing files", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-agents-dry-run-"));

    const install = await new AgentService().install({
      startPath: repoRoot,
      dryRun: true
    });

    expect(install.dryRun).toBe(true);
    await expect(
      access(path.join(repoRoot, ".github/agents/FeatureArchitect.agent.md"))
    ).rejects.toThrow();
  });

  it("backs up existing files when force overwrites", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-agents-backup-"));
    const agentDir = path.join(repoRoot, ".github/agents");
    const agentPath = path.join(agentDir, "FeatureArchitect.agent.md");

    await mkdir(agentDir, { recursive: true });
    await writeFile(agentPath, "old content", "utf8");

    const install = await new AgentService().install({
      startPath: repoRoot,
      force: true
    });
    const featureArchitect = install.results.find(
      (result) => result.agentId === "feature-architect"
    );

    expect(featureArchitect?.status).toBe("updated");
    expect(featureArchitect?.backupPath).toBeDefined();
    await access(featureArchitect?.backupPath ?? "");
    expect(await readFile(agentPath, "utf8")).toContain("name: FeatureArchitect");
  });

  it("validation catches malformed agent files", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-agents-invalid-"));
    const agentDir = path.join(repoRoot, ".github/agents");

    await mkdir(agentDir, { recursive: true });
    await writeFile(path.join(agentDir, "Broken.agent.md"), "not frontmatter", "utf8");

    const validation = await new AgentService().validate({ startPath: repoRoot });

    expect(validation.ok).toBe(false);
    expect(validation.files[0]?.errors).toEqual(
      expect.arrayContaining(["Missing YAML frontmatter block."])
    );
  });

  it("doctor explains the main agent entry points", () => {
    const report = new AgentService().doctor("v20.11.0");

    expect(report.summary).toContain("@FeatureArchitect");
    expect(report.summary).toContain("@FeatureImplementer");
    expect(report.summary).toContain("@CodeReviewer");
    expect(report.summary).toContain("@Debugger");
    expect(report.checks.map((check) => check.name)).toContain("mcp-config");
  });
});
