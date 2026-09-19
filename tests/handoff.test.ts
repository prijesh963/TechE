import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  FeaturePlanningService,
  HandoffService
} from "../packages/planner/src/index.js";
import { runCli } from "../packages/cli/src/index.js";
import { CHAT_COMMANDS } from "../packages/shared/src/index.js";

const execFileAsync = promisify(execFile);

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

describe("HandoffService", () => {
  it("blocks handoff generation without explicit approval", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "src/invoice.ts": "export const invoice = true;"
    });

    await new FeaturePlanningService().createPlan({
      startPath: repoRoot,
      request: "Add invoice approval workflow"
    });

    await expect(
      new HandoffService().generate({
        startPath: repoRoot,
        plan: "latest",
        copyToClipboard: false
      })
    ).rejects.toThrow("requires --approve");
  });

  it("generates required handoff prompt with plan, commands, safety, and artifacts", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({
        scripts: {
          build: "tsc -b",
          test: "vitest run"
        }
      }),
      "src/invoices/workflow.ts": "export const workflow = 'invoice approval';"
    });
    const planningService = new FeaturePlanningService();
    const created = await planningService.createPlan({
      startPath: repoRoot,
      request: "Add invoice approval workflow"
    });
    await planningService.approvePlan({
      startPath: repoRoot,
      planId: created.plan.id,
      revision: 1,
      approvedBy: "test-reviewer"
    });

    const result = await new HandoffService().generate({
      startPath: repoRoot,
      plan: "latest",
      approved: true,
      targetAgent: "codex",
      copyToClipboard: false
    });
    const markdown = await readFile(result.latestMarkdownPath, "utf8");

    expect(result.handoff.approved).toBe(true);
    expect(result.planPath).toBe(
      path.join(repoRoot, ".copilot-architect/plans/latest-plan.json")
    );
    expect(result.handoff.validationCommands.length).toBeGreaterThan(0);
    expect(result.clipboard.attempted).toBe(false);
    expect(markdown).toContain(CHAT_COMMANDS.implement);
    // Phase 5 deleted the .agent.md files. A handoff that still names one
    // sends the developer to a mention that resolves to nothing.
    expect(markdown).not.toContain("@FeatureImplementer");
    expect(markdown).toContain("Implement the approved plan below.");
    expect(markdown).toContain("Rules:");
    expect(markdown).toContain("Approved plan:");
    expect(markdown).toContain("Validation commands:");
    expect(markdown).toContain("Safety rules:");
    expect(markdown).toContain("npm test");
    expect(markdown).toContain("Do not run dangerous commands");
    expect(markdown).toContain("Target agent compatibility:");
    await readFile(result.latestJsonPath, "utf8");
  });

  it("creates a git checkpoint when git is available", async () => {
    if (!(await gitAvailable())) {
      return;
    }

    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "src/index.ts": "export const value = 1;"
    });

    await execFileAsync("git", ["init"], { cwd: repoRoot });
    await execFileAsync("git", ["add", "."], { cwd: repoRoot });
    await execFileAsync(
      "git",
      [
        "-c",
        "user.name=Copilot Architect",
        "-c",
        "user.email=copilot-architect@example.test",
        "commit",
        "-m",
        "initial"
      ],
      { cwd: repoRoot }
    );

    const planningService = new FeaturePlanningService();
    const created = await planningService.createPlan({
      startPath: repoRoot,
      request: "Add invoice approval workflow"
    });
    await planningService.approvePlan({
      startPath: repoRoot,
      planId: created.plan.id,
      revision: 1,
      approvedBy: "test-reviewer"
    });

    const result = await new HandoffService().generate({
      startPath: repoRoot,
      approved: true,
      copyToClipboard: false
    });

    expect(result.gitCheckpoint.created).toBe(true);
    // Normalize separators so assertion passes on both Windows (\) and Unix (/)
    expect(result.gitCheckpoint.checkpointPath?.replace(/\\/g, "/")).toContain(
      ".copilot-architect/diagnostics"
    );
  });
});

describe("handoff CLI", () => {
  it("supports --approve alias and returns full JSON evidence", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "src/invoice.ts": "export const invoice = true;"
    });
    const capture = createCapture();
    const approveCapture = createCapture();

    await new FeaturePlanningService().createPlan({
      startPath: repoRoot,
      request: "Add invoice approval workflow"
    });
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
            "test-reviewer"
          ],
          approveCapture.io
        )
      ).exitCode
    ).toBe(0);

    const result = await runCli(
      [
        "handoff",
        "--path",
        repoRoot,
        "--plan",
        "latest",
        "--approve",
        "--no-clipboard",
        "--json"
      ],
      capture.io
    );
    const json = JSON.parse(capture.stdout.join("\n"));

    expect(result.exitCode).toBe(0);
    expect(json.handoff.promptMarkdown).toContain(CHAT_COMMANDS.implement);
    expect(json.gitCheckpoint.message).toBeDefined();
    expect(json.clipboard.attempted).toBe(false);
  });
});

async function createRepo(files: Record<string, string>): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-handoff-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }

  return repoRoot;
}

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}
