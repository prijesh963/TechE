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

  it("renders the shared dashboard as HTML for a host that cannot import it directly", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "dashboard-html" })
    });
    const capture = createCapture();

    const result = await runCli(["dashboard", "--path", repoRoot], capture.io);
    const html = capture.stdout.join("\n");

    expect(result.exitCode).toBe(0);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Current work");
    expect(html).toContain("Agent insights");
    // No session/MCP process for a one-shot CLI call to introspect — honest
    // about both rather than guessing.
    expect(html).toContain("No session open");
    expect(html).toContain(">stopped<");
    // No caller-specific command scheme to assume, so no action row.
    expect(html).toContain('<div class="actions"></div>');
  });

  it("supports dashboard JSON output with the underlying data, not just HTML", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "dashboard-json" })
    });
    const capture = createCapture();

    const result = await runCli(
      ["dashboard", "--path", repoRoot, "--json"],
      capture.io
    );
    const json = JSON.parse(capture.stdout.join("\n"));

    expect(result.exitCode).toBe(0);
    expect(json.workspaceRoot).toBe(repoRoot);
    expect(json.html).toContain("<!doctype html>");
    expect(json.session).toBeUndefined();
    expect(json.artifacts).toBeDefined();
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

  it("runs the instructions command family", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "agents-instructions" })
    });
    const instructionsPreview = createCapture();
    const instructionsGenerate = createCapture();
    const instructionsValidate = createCapture();

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
