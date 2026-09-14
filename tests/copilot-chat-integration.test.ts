import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";
import { listCopilotArchitectMcpToolNames } from "../packages/mcp-server/src/index.js";

function createCapture() {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    io: {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message)
    }
  };
}

describe("Copilot Chat integration", () => {
  it("installs agents, instructions, prompts, and MCP config for Copilot Chat", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "src/invoice.ts": "export const invoice = true;"
    });
    const agentsCapture = createCapture();
    const instructionsCapture = createCapture();
    const mcpCapture = createCapture();
    const doctorCapture = createCapture();

    expect(
      (await runCli(["agents", "install", "--path", repoRoot], agentsCapture.io))
        .exitCode
    ).toBe(0);
    expect(
      (
        await runCli(
          ["instructions", "generate", "--path", repoRoot],
          instructionsCapture.io
        )
      ).exitCode
    ).toBe(0);
    expect(
      (await runCli(["mcp", "config", "--path", repoRoot], mcpCapture.io)).exitCode
    ).toBe(0);
    expect(
      (await runCli(["agents", "doctor", "--path", repoRoot], doctorCapture.io))
        .exitCode
    ).toBe(0);

    const featureArchitect = await readFile(
      path.join(repoRoot, ".github/agents/FeatureArchitect.agent.md"),
      "utf8"
    );
    const featureImplementer = await readFile(
      path.join(repoRoot, ".github/agents/FeatureImplementer.agent.md"),
      "utf8"
    );
    const codeReviewer = await readFile(
      path.join(repoRoot, ".github/agents/CodeReviewer.agent.md"),
      "utf8"
    );
    const mcpConfig = JSON.parse(
      await readFile(path.join(repoRoot, ".vscode/mcp.json"), "utf8")
    );

    expect(featureArchitect).toContain("agent: FeatureImplementer");
    expect(featureImplementer).toContain("agent: CodeReviewer");
    // The review flow has two exits — back to the Feature Planner when
    // findings are accepted, forward to TestPlanner when it is clean. Routing
    // to Debugger was removed; a human invokes @Debugger directly instead.
    expect(codeReviewer).toContain("agent: FeatureArchitect");
    expect(codeReviewer).toContain("agent: TestPlanner");
    expect(codeReviewer).not.toContain("agent: Debugger");
    expect(mcpConfig.servers.copilotArchitect.type).toBe("stdio");
    expect(doctorCapture.stdout.join("\n")).toContain("mcp-config: ok");
    expect(doctorCapture.stdout.join("\n")).toContain("agent-files: ok");
    await access(path.join(repoRoot, ".github/copilot-instructions.md"));
    await access(
      path.join(repoRoot, ".github/prompts/copilot-architect-plan.prompt.md")
    );
    expect(listCopilotArchitectMcpToolNames()).toContain("agent_status");
  });

  it("documents Copilot Chat connection and does not claim to modify internals", async () => {
    const readme = await readFile(path.join(process.cwd(), "README.md"), "utf8");

    expect(readme).toContain("Connect Copilot Chat To Copilot Architect MCP");
    expect(readme).toContain("MCP: List Servers");
    expect(readme).toContain("@FeatureArchitect I want to add [describe feature].");
    expect(readme).toContain(
      "@FeatureImplementer Implement the approved plan from .copilot-architect/plans/latest-plan.md."
    );
    expect(readme).toContain(
      "@CodeReviewer Review the implementation diff against the approved plan."
    );
    expect(readme).toContain("does not modify Copilot internals");
  });
});

async function createRepo(files: Record<string, string>): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-chat-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }

  return repoRoot;
}
