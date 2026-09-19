import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  IndexingService,
  resetIndexFreshnessCache
} from "../packages/indexer/src/index.js";
import {
  applyPlanChanges,
  buildPlannedChange,
  compareAgainstPlan,
  createPlanContract,
  plannedPaths,
  verifyPlanFreshness
} from "../packages/planner/src/index.js";
import {
  SessionService,
  checkConstraints,
  diffCheckpoint
} from "../packages/session/src/index.js";

describe("applyPlanChanges", () => {
  it("writes, creates and deletes inside the workspace", async () => {
    const workspaceRoot = await createRepo({
      "src/update-me.ts": "export const old = 1;",
      "src/delete-me.ts": "export const gone = 1;"
    });

    const result = await applyPlanChanges({
      workspaceRoot,
      changes: [
        {
          relativePath: "src/update-me.ts",
          kind: "update",
          afterText: "export const now = 2;"
        },
        {
          relativePath: "src/nested/new-file.ts",
          kind: "add",
          afterText: "export const added = 3;"
        },
        { relativePath: "src/delete-me.ts", kind: "delete" }
      ]
    });

    expect(result.written.sort()).toEqual([
      "src/nested/new-file.ts",
      "src/update-me.ts"
    ]);
    expect(result.deleted).toEqual(["src/delete-me.ts"]);
    expect(result.refused).toEqual([]);

    expect(await readFile(path.join(workspaceRoot, "src/update-me.ts"), "utf8")).toBe(
      "export const now = 2;"
    );
    // A new file's parent directory is created rather than failing the change.
    expect(
      await readFile(path.join(workspaceRoot, "src/nested/new-file.ts"), "utf8")
    ).toBe("export const added = 3;");
  });

  it("refuses to write outside the workspace root", async () => {
    // A plan is data. Data that names ../../ must not reach outside the repo
    // just because a model produced it.
    const workspaceRoot = await createRepo({ "src/a.ts": "export const a = 1;" });

    const result = await applyPlanChanges({
      workspaceRoot,
      changes: [
        { relativePath: "../escaped.ts", kind: "add", afterText: "nope" },
        { relativePath: "../../etc/passwd", kind: "update", afterText: "nope" },
        { relativePath: "src/a.ts", kind: "update", afterText: "export const a = 2;" }
      ]
    });

    expect(result.refused.map((r) => r.relativePath)).toEqual([
      "../escaped.ts",
      "../../etc/passwd"
    ]);
    expect(result.refused[0].reason).toContain("outside the workspace root");
    // The legitimate change still lands — one bad path does not abandon the rest.
    expect(result.written).toEqual(["src/a.ts"]);
  });

  it("refuses an update with no replacement rather than emptying the file", async () => {
    const workspaceRoot = await createRepo({ "src/a.ts": "export const a = 1;" });

    const result = await applyPlanChanges({
      workspaceRoot,
      changes: [{ relativePath: "src/a.ts", kind: "update" }]
    });

    expect(result.written).toEqual([]);
    expect(result.refused[0].reason).toContain("no replacement content");
    // Untouched, not truncated.
    expect(await readFile(path.join(workspaceRoot, "src/a.ts"), "utf8")).toBe(
      "export const a = 1;"
    );
  });
});

describe("compareAgainstPlan", () => {
  it("separates planned work from scope creep", async () => {
    // The finding that used to pass silently: a file changed that the plan
    // never mentioned, possibly the riskiest thing in the diff.
    const plan = createPlanContract({
      request: "Add invoice approval",
      version: 1,
      decisions: [],
      changes: [
        { kind: "update", relativePath: "src/planned-a.ts", rationale: "x" },
        { kind: "update", relativePath: "src/planned-b.ts", rationale: "y" },
        { kind: "update", relativePath: "src/never-touched.ts", rationale: "z" }
      ]
    });

    const comparison = compareAgainstPlan(plan, {
      added: ["src/surprise.ts"],
      modified: ["src/planned-a.ts", "src/planned-b.ts"],
      deleted: ["src/removed.ts"]
    });

    expect(comparison.asPlanned).toEqual(["src/planned-a.ts", "src/planned-b.ts"]);
    expect(comparison.unplanned).toEqual(["src/surprise.ts"]);
    // Planned but unchanged may mean the work is incomplete.
    expect(comparison.untouched).toEqual(["src/never-touched.ts"]);
    expect(comparison.deleted).toEqual(["src/removed.ts"]);
  });

  it("qualifies paths by repo, matching the plan", () => {
    const plan = createPlanContract({
      request: "Add invoice approval",
      version: 1,
      decisions: [],
      changes: [
        {
          kind: "update",
          repoName: "svc-billing",
          relativePath: "src/Ledger.java",
          rationale: "x"
        }
      ]
    });

    const comparison = compareAgainstPlan(plan, {
      added: [],
      modified: ["svc-billing/src/Ledger.java"],
      deleted: []
    });

    expect(comparison.asPlanned).toEqual(["svc-billing/src/Ledger.java"]);
    expect(comparison.unplanned).toEqual([]);
  });
});

describe("the plan → approve → implement → review loop", () => {
  it("refuses to implement a plan whose files moved underneath it", async () => {
    // Same-day work keeps drift small but not zero, and patching a file
    // against a stale snapshot corrupts it silently.
    const workspaceRoot = await createRepo({ "src/a.ts": "export const a = 1;" });
    const sessions = new SessionService();
    await sessions.open({ workspaceRoot, title: "Add approval" });

    const plan = createPlanContract({
      request: "Add approval",
      version: 1,
      decisions: [],
      changes: [
        await buildPlannedChange({
          repoRoot: workspaceRoot,
          relativePath: "src/a.ts",
          kind: "update",
          rationale: "x"
        })
      ]
    });
    await sessions.addPlanVersion({ workspaceRoot }, { ...plan });
    await sessions.approvePlan({ workspaceRoot }, 1);

    expect((await verifyPlanFreshness(plan, workspaceRoot)).ok).toBe(true);

    // Someone edits the file after approval.
    await writeFile(
      path.join(workspaceRoot, "src/a.ts"),
      "export const a = 999;",
      "utf8"
    );

    const freshness = await verifyPlanFreshness(plan, workspaceRoot);
    expect(freshness.ok).toBe(false);
    expect(freshness.drifted).toEqual(["src/a.ts"]);
  });

  it("blocks a plan that would breach a confirmed constraint", async () => {
    const workspaceRoot = await createRepo({
      "src/InvoiceController.ts": "export class InvoiceController {}"
    });
    const sessions = new SessionService();
    await sessions.open({ workspaceRoot, title: "Add approval" });
    const session = await sessions.recordDecision(
      { workspaceRoot },
      {
        kind: "constraint",
        statement: "Do not modify InvoiceController — it is shared",
        enforcement: { forbidPaths: ["src/InvoiceController.ts"] }
      }
    );

    const plan = createPlanContract({
      request: "Add approval",
      version: 1,
      decisions: sessions.activeDecisions(session),
      changes: [
        {
          kind: "update",
          relativePath: "src/InvoiceController.ts",
          rationale: "needs a hook"
        }
      ]
    });

    const check = checkConstraints(
      sessions.activeDecisions(session),
      plannedPaths(plan)
    );

    // The constraint is enforced, not merely recorded in a prompt.
    expect(check.violations).toHaveLength(1);
    expect(check.violations[0].paths).toEqual(["src/InvoiceController.ts"]);
  });

  it("separates planned changes from scope creep after implementing", async () => {
    const workspaceRoot = await createRepo({
      "src/planned.ts": "export const planned = 1;",
      "src/other.ts": "export const other = 1;"
    });
    const sessions = new SessionService();
    const indexing = new IndexingService();
    await sessions.open({ workspaceRoot, title: "Add approval" });

    const plan = createPlanContract({
      request: "Add approval",
      version: 1,
      decisions: [],
      changes: [{ kind: "update", relativePath: "src/planned.ts", rationale: "x" }]
    });
    await sessions.addPlanVersion({ workspaceRoot }, { ...plan });
    await sessions.approvePlan({ workspaceRoot }, 1);

    // Checkpoint before writing, exactly as /implement does.
    await sessions.captureCheckpoint(
      { workspaceRoot },
      await indexing.fileHashes({ startPath: workspaceRoot })
    );

    await applyPlanChanges({
      workspaceRoot,
      changes: [
        {
          relativePath: "src/planned.ts",
          kind: "update",
          afterText: "export const planned = 2;"
        },
        // A hand edit nobody planned — the finding that used to pass silently.
        {
          relativePath: "src/other.ts",
          kind: "update",
          afterText: "export const other = 2;"
        }
      ]
    });

    resetIndexFreshnessCache();
    const session = await sessions.current({ workspaceRoot });
    const comparison = compareAgainstPlan(
      plan,
      diffCheckpoint(
        session!.checkpoint!,
        await indexing.fileHashes({ startPath: workspaceRoot })
      )
    );

    expect(comparison.asPlanned).toEqual(["src/planned.ts"]);
    expect(comparison.unplanned).toEqual(["src/other.ts"]);
  });
});

async function createRepo(files: Record<string, string>): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-exec-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }

  return repoRoot;
}
