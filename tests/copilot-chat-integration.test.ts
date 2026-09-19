import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CHAT_COMMANDS } from "../packages/shared/src/index.js";

import { runCli } from "../packages/cli/src/index.js";

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
  it("generates instructions, prompts and MCP config for Copilot Chat", async () => {
    // Agent installation is gone: the roles are internal to @architect, so
    // there is nothing to write into .github/agents/ and nothing that can be
    // out of date with the code using it.
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "src/invoice.ts": "export const invoice = true;"
    });
    const instructionsCapture = createCapture();
    const mcpCapture = createCapture();

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

    const mcpConfig = JSON.parse(
      await readFile(path.join(repoRoot, ".vscode/mcp.json"), "utf8")
    );
    expect(mcpConfig.servers.copilotArchitect.type).toBe("stdio");

    // MCP stays: it is how tools outside this extension — plain Copilot,
    // another agent — reach the repo intelligence.
    await access(path.join(repoRoot, ".github/copilot-instructions.md"));
  });

  it("documents Copilot Chat connection and does not claim to modify internals", async () => {
    const readme = await readFile(path.join(process.cwd(), "README.md"), "utf8");

    expect(readme).toContain("MCP: List Servers");
    expect(readme).toContain("does not modify Copilot internals");

    // The four phases of the one front door, and nothing that points at an
    // agent Phase 5 deleted. A README that names a dead mention sends a
    // developer to type into the void and report that "the agent" is broken.
    for (const command of Object.values(CHAT_COMMANDS)) {
      expect(readme).toContain(command);
    }
    for (const dead of [
      "@FeatureArchitect ",
      "@FeatureImplementer",
      "@CodeReviewer",
      "@TestPlanner",
      "@CodeAnalysisAgent"
    ]) {
      expect(readme).not.toContain(dead);
    }
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
