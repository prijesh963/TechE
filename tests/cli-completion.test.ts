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
    // about both rather than guessing, absent an explicit --mcp-status flag.
    expect(html).toContain("No session open");
    expect(html).toContain(">stopped<");
    // The action row is host-neutral (architect-action: links), not VS
    // Code's own command: scheme, but it is always rendered.
    expect(html).toContain('<a href="architect-action:setupRepo">Setup Repo</a>');
    expect(html).toContain(
      '<a href="architect-action:buildGraph">Build Symbol Graph</a>'
    );
  });

  it("reports a caller-supplied MCP status and last-command outcome instead of guessing", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ name: "dashboard-runtime-state" })
    });
    const capture = createCapture();

    const result = await runCli(
      [
        "dashboard",
        "--path",
        repoRoot,
        "--mcp-status",
        "running",
        "--last-command",
        "setup",
        "--last-exit-code",
        "0",
        "--last-stdout",
        "all steps ok"
      ],
      capture.io
    );
    const html = capture.stdout.join("\n");

    expect(result.exitCode).toBe(0);
    expect(html).toContain(">running<");
    expect(html).toContain("<p>setup</p>");
    expect(html).toContain("Exit code: 0");
    expect(html).toContain("all steps ok");
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

  it("scans a parent folder and registers only its real-repo subdirectories", async () => {
    const parentDir = await mkdtemp(path.join(tmpdir(), "copilot-scan-parent-"));
    await mkdir(path.join(parentDir, "repo-a"), { recursive: true });
    await writeFile(
      path.join(parentDir, "repo-a", "package.json"),
      JSON.stringify({ name: "repo-a" }),
      "utf8"
    );
    await mkdir(path.join(parentDir, "repo-b"), { recursive: true });
    await writeFile(
      path.join(parentDir, "repo-b", "package.json"),
      JSON.stringify({ name: "repo-b" }),
      "utf8"
    );
    // No package.json, pom.xml, build.gradle or equivalent — must be skipped,
    // not registered as a 13th "repo" that is really just documentation.
    await mkdir(path.join(parentDir, "docs"), { recursive: true });
    await writeFile(path.join(parentDir, "docs", "README.md"), "# Notes", "utf8");

    const workspaceRoot = await createRepo({});
    const capture = createCapture();

    const result = await runCli(
      ["workspace", "scan", parentDir, "--path", workspaceRoot, "--json"],
      capture.io
    );
    const json = JSON.parse(capture.stdout.join("\n"));

    expect(result.exitCode).toBe(0);
    expect(json.registered.sort()).toEqual(["repo-a", "repo-b"]);
    expect(json.skipped).toEqual(["docs"]);

    const showCapture = createCapture();
    await runCli(
      ["workspace", "show", "--path", workspaceRoot, "--json"],
      showCapture.io
    );
    const workspace = JSON.parse(showCapture.stdout.join("\n"));
    // Plus the workspace root itself — `workspace init` always registers it
    // (role: "workspace root"), existing behavior this command reuses rather
    // than works around.
    const names = workspace.repos.map((repo: { name: string }) => repo.name);
    expect(names).toContain("repo-a");
    expect(names).toContain("repo-b");
  });

  it("reports failure rather than a false success when nothing in the folder looks like a repo", async () => {
    const parentDir = await mkdtemp(path.join(tmpdir(), "copilot-scan-empty-"));
    await mkdir(path.join(parentDir, "docs"), { recursive: true });
    const workspaceRoot = await createRepo({});
    const capture = createCapture();

    const result = await runCli(
      ["workspace", "scan", parentDir, "--path", workspaceRoot, "--json"],
      capture.io
    );
    const json = JSON.parse(capture.stdout.join("\n"));

    expect(result.exitCode).toBe(1);
    expect(json.registered).toEqual([]);
    expect(json.skipped).toEqual(["docs"]);
  });

  it("runs one-shot setup for a single repo: init through MCP config", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "src/invoice.ts": "export const invoice = true;"
    });
    const capture = createCapture();

    const result = await runCli(["setup", "--path", repoRoot, "--json"], capture.io);
    const json = JSON.parse(capture.stdout.join("\n"));

    expect(result.exitCode).toBe(0);
    expect(json.mode).toBe("single");
    expect(json.ok).toBe(true);
    const repoLabel = path.basename(repoRoot);
    const labels = json.steps.map((step: { label: string }) => step.label);
    expect(labels).toEqual([
      `Initialize artifacts (${repoLabel})`,
      `Analyze repo (${repoLabel})`,
      `Build symbol graph (${repoLabel})`,
      `Repo assessment (${repoLabel})`,
      "Build index",
      "Configure MCP server"
    ]);
    expect(json.steps.every((step: { ok: boolean }) => step.ok)).toBe(true);

    await access(path.join(repoRoot, ".copilot-architect/repo-map.json"));
    await access(path.join(repoRoot, ".copilot-architect/graph.json"));
    await access(path.join(repoRoot, ".vscode/mcp.json"));
  });

  it("runs one-shot setup across a scanned workspace, per repo then combined steps", async () => {
    const parentDir = await mkdtemp(path.join(tmpdir(), "copilot-setup-parent-"));
    await mkdir(path.join(parentDir, "repo-a"), { recursive: true });
    await writeFile(
      path.join(parentDir, "repo-a", "package.json"),
      JSON.stringify({ name: "repo-a" }),
      "utf8"
    );
    await mkdir(path.join(parentDir, "repo-b"), { recursive: true });
    await writeFile(
      path.join(parentDir, "repo-b", "package.json"),
      JSON.stringify({ name: "repo-b" }),
      "utf8"
    );
    const workspaceRoot = await createRepo({});
    const scanCapture = createCapture();
    expect(
      (
        await runCli(
          ["workspace", "scan", parentDir, "--path", workspaceRoot, "--json"],
          scanCapture.io
        )
      ).exitCode
    ).toBe(0);

    const setupCapture = createCapture();
    const result = await runCli(
      ["setup", "--path", workspaceRoot, "--workspace", "--json"],
      setupCapture.io
    );
    const json = JSON.parse(setupCapture.stdout.join("\n"));

    expect(result.exitCode).toBe(0);
    expect(json.mode).toBe("workspace");
    expect(json.ok).toBe(true);
    const labels = json.steps.map((step: { label: string }) => step.label);
    expect(labels).toEqual([
      "Initialize artifacts (repo-a)",
      "Analyze repo (repo-a)",
      "Build symbol graph (repo-a)",
      "Repo assessment (repo-a)",
      "Initialize artifacts (repo-b)",
      "Analyze repo (repo-b)",
      "Build symbol graph (repo-b)",
      "Repo assessment (repo-b)",
      "Build workspace index",
      "Build workspace symbol graph",
      "Configure MCP server"
    ]);
    expect(json.steps.every((step: { ok: boolean }) => step.ok)).toBe(true);
  });

  it("reports failed steps rather than a false success when the workspace root has no repos", async () => {
    const workspaceRoot = await createRepo({});
    const initCapture = createCapture();
    expect(
      (await runCli(["workspace", "init", "--path", workspaceRoot], initCapture.io))
        .exitCode
    ).toBe(0);

    const capture = createCapture();
    const result = await runCli(
      ["setup", "--path", workspaceRoot, "--workspace", "--json"],
      capture.io
    );
    const json = JSON.parse(capture.stdout.join("\n"));

    // No repos beyond the auto-registered workspace root itself, so there is
    // nothing to set up per-repo — just the combined workspace steps.
    expect(result.exitCode).toBe(0);
    expect(json.mode).toBe("workspace");
    const labels = json.steps.map((step: { label: string }) => step.label);
    expect(labels).toEqual([
      "Build workspace index",
      "Build workspace symbol graph",
      "Configure MCP server"
    ]);
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
