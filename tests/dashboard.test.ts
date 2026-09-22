import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDashboardHtml,
  loadDashboardArtifacts,
  loadDashboardSession,
  type ExtensionState
} from "../packages/dashboard/src/index.js";

const baseState: ExtensionState = {
  workspaceRoot: "/workspace/repo",
  mcpStatus: "stopped"
};

describe("@copilot-architect/dashboard", () => {
  it("renders a complete page with no host-specific wiring at all", () => {
    // The whole point of extracting this package: it must produce a full,
    // valid dashboard with zero knowledge of VS Code, IntelliJ, or any other
    // host — no actionsHtml, no buildVersion.
    const html = createDashboardHtml(baseState);

    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Current work");
    expect(html).toContain("Agent insights");
    // Falls back honestly rather than inventing a version string.
    expect(html).toContain("unknown");
    // Empty but valid — no host-specific command scheme baked in.
    expect(html).toContain('<div class="actions"></div>');
  });

  it("renders host-supplied action links exactly as given, never its own scheme", () => {
    const html = createDashboardHtml(baseState, {
      actionsHtml: '<a href="architect-action:setupRepo">Setup Repo</a>'
    });

    expect(html).toContain(
      '<div class="actions"><a href="architect-action:setupRepo">'
    );
    expect(html).not.toContain("command:copilotArchitect");
  });

  it("uses the host's own build version when supplied", () => {
    const html = createDashboardHtml({ ...baseState, buildVersion: "1.2.3" });

    expect(html).toContain("1.2.3");
    expect(html).not.toContain(">unknown<");
  });

  it("returns empty artifacts for a workspace with nothing on disk yet", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "copilot-dashboard-pkg-"));

    const artifacts = await loadDashboardArtifacts(workspaceRoot);

    expect(artifacts.languages).toBeUndefined();
    expect(artifacts.latestPlan).toBeUndefined();
    expect(artifacts.contextInsights).toBeUndefined();
    expect(artifacts.agentCount).toBe(0);
  });

  it("returns undefined for a workspace with no session open", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "copilot-dashboard-pkg-"));

    expect(await loadDashboardSession(workspaceRoot)).toBeUndefined();
  });

  it("reads the latest plan's revision and revision count for the approve/diff action links", async () => {
    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "copilot-dashboard-pkg-"));
    const plansDir = path.join(workspaceRoot, ".copilot-architect", "plans");
    await mkdir(plansDir, { recursive: true });
    await writeFile(
      path.join(plansDir, "latest-plan.json"),
      JSON.stringify({
        title: "Add invoice approval workflow",
        status: "draft",
        generatedAt: "2026-01-01T00:00:00.000Z",
        revision: 2,
        revisions: [{ revision: 1 }, { revision: 2 }]
      }),
      "utf8"
    );

    const artifacts = await loadDashboardArtifacts(workspaceRoot);

    expect(artifacts.latestPlan).toMatchObject({
      title: "Add invoice approval workflow",
      status: "draft",
      revision: 2,
      revisionCount: 2
    });
  });
});
