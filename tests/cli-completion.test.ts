import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";
import { CLI_COMMANDS } from "../packages/shared/src/index.js";

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

describe("Phase 12 CLI completion", () => {
  it("provides help for every top-level command", async () => {
    for (const command of CLI_COMMANDS) {
      const capture = createCapture();
      const result = await runCli([command, "--help"], capture.io);

      expect(result.exitCode).toBe(0);
      expect(capture.stdout.join("\n")).toContain("Usage:");
      expect(capture.stdout.join("\n")).toContain(`npm run cli -- ${command}`);
    }
  });

  it("supports status JSON output", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "status-json" })
    });
    const capture = createCapture();

    const result = await runCli(["status", "--path", repoRoot, "--json"], capture.io);
    const json = JSON.parse(capture.stdout.join("\n"));

    expect(result.exitCode).toBe(0);
    expect(json.workspaceRoot).toBe(repoRoot);
    expect(json.artifacts.map((artifact: { name: string }) => artifact.name)).toContain(
      "repo-map"
    );
  });

  it("runs workspace init, add, show, search, and validate-plan commands", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({
        scripts: { test: "vitest run" }
      }),
      "src/invoice.ts": "export const invoice = 'approved';"
    });
    const otherRoot = await createRepo({
      "package.json": JSON.stringify({ name: "other" }),
      "src/customer.ts": "export const customer = true;"
    });
    const initCapture = createCapture();
    const addCapture = createCapture();
    const searchCapture = createCapture();
    const planCapture = createCapture();
    const validateCapture = createCapture();

    expect(
      (await runCli(["workspace", "init", "--path", repoRoot], initCapture.io)).exitCode
    ).toBe(0);
    expect(
      (
        await runCli(
          ["workspace", "add", "--path", repoRoot, "--repo", otherRoot],
          addCapture.io
        )
      ).exitCode
    ).toBe(0);
    expect(
      (
        await runCli(
          ["workspace", "search", "invoice", "--path", repoRoot],
          searchCapture.io
        )
      ).exitCode
    ).toBe(0);
    expect(
      (
        await runCli(
          ["workspace", "plan", "Add invoice workflow", "--path", repoRoot],
          planCapture.io
        )
      ).exitCode
    ).toBe(0);
    expect(
      (
        await runCli(
          ["workspace", "validate-plan", "--path", repoRoot],
          validateCapture.io
        )
      ).exitCode
    ).toBe(0);
    expect(addCapture.stdout.join("\n")).toContain("Repos: 2");
    expect(searchCapture.stdout.join("\n")).toContain("Results:");
    expect(validateCapture.stdout.join("\n")).toContain("Status: ok");
  });

  it("runs agents and instructions command families", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "agents-instructions" })
    });
    const agentsList = createCapture();
    const agentsInstall = createCapture();
    const agentsValidate = createCapture();
    const instructionsPreview = createCapture();
    const instructionsGenerate = createCapture();
    const instructionsValidate = createCapture();

    expect((await runCli(["agents", "list"], agentsList.io)).exitCode).toBe(0);
    expect(
      (await runCli(["agents", "install", "--path", repoRoot], agentsInstall.io))
        .exitCode
    ).toBe(0);
    expect(
      (await runCli(["agents", "validate", "--path", repoRoot], agentsValidate.io))
        .exitCode
    ).toBe(0);
    expect(
      (await runCli(["instructions", "preview"], instructionsPreview.io)).exitCode
    ).toBe(0);
    expect(
      (
        await runCli(
          ["instructions", "generate", "--path", repoRoot],
          instructionsGenerate.io
        )
      ).exitCode
    ).toBe(0);
    expect(
      (
        await runCli(
          ["instructions", "validate", "--path", repoRoot],
          instructionsValidate.io
        )
      ).exitCode
    ).toBe(0);
    expect(agentsList.stdout.join("\n")).toContain("Templates:");
    expect(agentsValidate.stdout.join("\n")).toContain("Status: ok");
    expect(instructionsPreview.stdout.join("\n")).toContain("Copilot Architect");
    expect(instructionsValidate.stdout.join("\n")).toContain("Status: ok");
  });

  it("requires handoff approval and generates handoff and review artifacts", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "src/invoice.ts": "export const invoice = true;"
    });
    const planCapture = createCapture();
    const approveCapture = createCapture();
    const blockedHandoff = createCapture();
    const handoffCapture = createCapture();
    const reviewCapture = createCapture();

    expect(
      (
        await runCli(
          ["plan", "Add invoice approval workflow", "--path", repoRoot],
          planCapture.io
        )
      ).exitCode
    ).toBe(0);
    expect(
      (await runCli(["handoff", "--path", repoRoot], blockedHandoff.io)).exitCode
    ).toBe(1);
    expect(blockedHandoff.stderr.join("\n")).toContain("requires --approve");
    expect(
      (
        await runCli(
          [
            "plan",
            "approve",
            "--path",
            repoRoot,
            "--revision",
            "1",
            "--by",
            "reviewer"
          ],
          approveCapture.io
        )
      ).exitCode
    ).toBe(0);
    expect(
      (
        await runCli(
          [
            "handoff",
            "--path",
            repoRoot,
            "--approve",
            "--target",
            "codex",
            "--no-clipboard"
          ],
          handoffCapture.io
        )
      ).exitCode
    ).toBe(0);
    expect(
      (await runCli(["review", "--path", repoRoot], reviewCapture.io)).exitCode
    ).toBe(0);

    await access(
      path.join(repoRoot, ".copilot-architect/handoffs/latest-handoff.json")
    );
    await access(path.join(repoRoot, ".copilot-architect/reviews/latest-review.json"));
    expect(handoffCapture.stdout.join("\n")).toContain("Target agent: codex");
    expect(reviewCapture.stdout.join("\n")).toContain("Review JSON:");
  }, 20_000);
});

async function createRepo(files: Record<string, string>): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-cli-completion-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }

  return repoRoot;
}
