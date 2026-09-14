import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AgentService } from "../packages/agents/src/index.js";
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

describe("agents CLI", () => {
  it("installs agents as JSON using --output json", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-agents-cli-json-"));
    const capture = createCapture();

    const result = await runCli(
      ["agents", "install", "--path", repoRoot, "--output", "json"],
      capture.io
    );
    const json = JSON.parse(capture.stdout.join("\n"));

    expect(result.exitCode).toBe(0);
    // Assert against the actual template roster rather than a hardcoded
    // count, so this doesn't go stale again as templates are added.
    expect(json.results).toHaveLength(new AgentService().list().templates.length);
    expect(json.outputDirectory).toBe(path.join(repoRoot, ".github/agents"));
    await access(path.join(repoRoot, ".github/agents/CodeReviewer.agent.md"));
  });

  it("supports custom output paths, validation, and dry-run", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-agents-cli-output-"));
    const dryRunCapture = createCapture();
    const installCapture = createCapture();
    const validateCapture = createCapture();

    const dryRun = await runCli(
      [
        "agents",
        "install",
        "--path",
        repoRoot,
        "--output",
        "custom-agents",
        "--dry-run"
      ],
      dryRunCapture.io
    );

    expect(dryRun.exitCode).toBe(0);
    await expect(
      access(path.join(repoRoot, "custom-agents/FeatureArchitect.agent.md"))
    ).rejects.toThrow();

    expect(
      (
        await runCli(
          ["agents", "install", "--path", repoRoot, "--output", "custom-agents"],
          installCapture.io
        )
      ).exitCode
    ).toBe(0);
    expect(
      (
        await runCli(
          ["agents", "validate", "--path", repoRoot, "--output", "custom-agents"],
          validateCapture.io
        )
      ).exitCode
    ).toBe(0);
    expect(validateCapture.stdout.join("\n")).toContain("Status: ok");
  });

  it("updates existing agents with backups and reports doctor guidance", async () => {
    const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-agents-cli-update-"));
    const agentDir = path.join(repoRoot, ".github/agents");
    const agentPath = path.join(agentDir, "FeatureArchitect.agent.md");
    const updateCapture = createCapture();
    const doctorCapture = createCapture();

    await mkdir(agentDir, { recursive: true });
    await writeFile(agentPath, "old content", "utf8");

    expect(
      (await runCli(["agents", "update", "--path", repoRoot], updateCapture.io))
        .exitCode
    ).toBe(0);
    expect(updateCapture.stdout.join("\n")).toContain("backup:");
    expect(await readFile(agentPath, "utf8")).toContain("name: FeatureArchitect");

    expect((await runCli(["agents", "doctor"], doctorCapture.io)).exitCode).toBe(0);
    expect(doctorCapture.stdout.join("\n")).toContain("@FeatureArchitect");
    expect(doctorCapture.stdout.join("\n")).toContain("@FeatureImplementer");
    expect(doctorCapture.stdout.join("\n")).toContain("@CodeReviewer");
  });
});
