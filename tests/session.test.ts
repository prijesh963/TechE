import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  SessionService,
  checkConstraints,
  diffCheckpoint
} from "../packages/session/src/index.js";

const execFileAsync = promisify(execFile);

describe("SessionService", () => {
  it("keeps one session active and parks rather than discards the last", async () => {
    // One feature at a time removes session-switching from the interface. That
    // is only acceptable because nothing is lost — a developer pulled onto a
    // production issue mid-plan gets their thinking back.
    const workspaceRoot = await createWorkspace();
    const service = new SessionService();

    await service.open({ workspaceRoot, title: "Invoice approval" });
    await service.recordDecision(
      { workspaceRoot },
      { kind: "design", statement: "Use Kafka", rejected: "synchronous REST" }
    );
    await service.open({ workspaceRoot, title: "Hotfix payment timeout" });

    const active = await service.current({ workspaceRoot });
    expect(active?.title).toBe("Hotfix payment timeout");

    const all = await service.list({ workspaceRoot });
    const parked = all.find((session) => session.title === "Invoice approval");
    expect(parked?.status).toBe("parked");
    // The earlier thinking survives intact.
    expect(parked?.decisions[0]?.statement).toBe("Use Kafka");
    expect(parked?.decisions[0]?.rejected).toBe("synchronous REST");
  });

  it("parks a session when the branch moves under it", async () => {
    if (!(await gitAvailable())) return;

    const workspaceRoot = await createWorkspace();
    await execFileAsync("git", ["init", "-b", "main"], { cwd: workspaceRoot });
    await writeFile(path.join(workspaceRoot, "app.ts"), "export const a = 1;", "utf8");
    await commitAll(workspaceRoot, "initial");

    const service = new SessionService();
    await service.open({ workspaceRoot, title: "Invoice approval" });
    expect((await service.current({ workspaceRoot }))?.title).toBe("Invoice approval");

    await execFileAsync("git", ["checkout", "-b", "other"], { cwd: workspaceRoot });

    // A session belongs to the work on a branch. Left active, Tuesday's plan
    // would quietly shape Thursday's answer on a different branch.
    expect(await service.current({ workspaceRoot })).toBeUndefined();

    const parked = (await service.list({ workspaceRoot }))[0];
    expect(parked.status).toBe("parked");
    expect(parked.closedReason).toContain("branch changed");
  });

  it("peeks at a moved branch without parking the session", async () => {
    if (!(await gitAvailable())) return;

    const workspaceRoot = await createWorkspace();
    await execFileAsync("git", ["init", "-b", "main"], { cwd: workspaceRoot });
    await writeFile(path.join(workspaceRoot, "app.ts"), "export const a = 1;", "utf8");
    await commitAll(workspaceRoot, "initial");

    const service = new SessionService();
    await service.open({ workspaceRoot, title: "Invoice approval" });
    await execFileAsync("git", ["checkout", "-b", "other"], { cwd: workspaceRoot });

    // Reporting staleness must not cause it. A dashboard repaint calls this,
    // and ending the developer's session because a panel was drawn would be
    // the worst kind of side effect.
    const peeked = await service.peek({ workspaceRoot });
    expect(peeked?.staleBranch).toBe(true);
    expect(peeked?.session.status).toBe("active");
    expect((await service.list({ workspaceRoot }))[0].status).toBe("active");

    // current() still parks it, because it is about to act on it.
    expect(await service.current({ workspaceRoot })).toBeUndefined();
    expect((await service.list({ workspaceRoot }))[0].status).toBe("parked");
  });

  it("survives being reloaded from disk", async () => {
    // Developers reload VS Code constantly. An in-memory session would lose a
    // half-built plan every time.
    const workspaceRoot = await createWorkspace();
    await new SessionService().open({ workspaceRoot, title: "Invoice approval" });

    const reopened = await new SessionService().current({ workspaceRoot });

    expect(reopened?.title).toBe("Invoice approval");
    expect(reopened?.phase).toBe("analyze");
  });

  it("supersedes a decision without losing why it changed", async () => {
    const workspaceRoot = await createWorkspace();
    const service = new SessionService();
    await service.open({ workspaceRoot, title: "Invoice approval" });

    const first = await service.recordDecision(
      { workspaceRoot },
      { kind: "design", statement: "Use Kafka", rejected: "synchronous REST" }
    );
    const changed = await service.recordDecision(
      { workspaceRoot },
      {
        kind: "design",
        statement: "Use synchronous REST after all",
        supersedes: first.decisions[0].id
      }
    );

    // Both are kept; only the survivor is in force.
    expect(changed.decisions).toHaveLength(2);
    expect(service.activeDecisions(changed).map((d) => d.statement)).toEqual([
      "Use synchronous REST after all"
    ]);

    await expect(
      service.recordDecision(
        { workspaceRoot },
        { kind: "design", statement: "x", supersedes: "d99" }
      )
    ).rejects.toThrow(/No decision to supersede/);
  });

  it("treats approval as the gate that authorizes implementation", async () => {
    const workspaceRoot = await createWorkspace();
    const service = new SessionService();
    await service.open({ workspaceRoot, title: "Invoice approval" });

    await service.addPlanVersion({ workspaceRoot }, { summary: "v1" });
    const drafted = await service.current({ workspaceRoot });
    // A draft is not a plan anything may act on.
    expect(service.latestApprovedPlan(drafted!)).toBeUndefined();
    await expect(service.markImplemented({ workspaceRoot }, 1)).rejects.toThrow(
      /not approved/
    );

    const approved = await service.approvePlan({ workspaceRoot }, 1);
    expect(service.latestApprovedPlan(approved)?.version).toBe(1);
    expect(service.hasPendingWork(approved)).toBe(true);

    const implemented = await service.markImplemented({ workspaceRoot }, 1);
    expect(service.hasPendingWork(implemented)).toBe(false);
  });

  it("implements the latest approved version, not the latest draft", async () => {
    // The review loop produces a v2. Until it is approved, v1 is still what
    // implementation should apply — otherwise the gate means nothing.
    const workspaceRoot = await createWorkspace();
    const service = new SessionService();
    await service.open({ workspaceRoot, title: "Invoice approval" });

    await service.addPlanVersion({ workspaceRoot }, { summary: "v1" });
    await service.approvePlan({ workspaceRoot }, 1);
    await service.markImplemented({ workspaceRoot }, 1);
    const withDraft = await service.addPlanVersion(
      { workspaceRoot },
      { summary: "v2" }
    );

    expect(service.latestApprovedPlan(withDraft)?.version).toBe(1);
    expect(service.hasPendingWork(withDraft)).toBe(false);

    const approved = await service.approvePlan({ workspaceRoot }, 2);
    expect(service.latestApprovedPlan(approved)?.version).toBe(2);
    // v2 approved but not implemented — there is pending work, and the session
    // can say so rather than looking finished.
    expect(service.hasPendingWork(approved)).toBe(true);
  });

  it("refuses to mutate when no session is active", async () => {
    const workspaceRoot = await createWorkspace();
    await expect(
      new SessionService().setPhase({ workspaceRoot }, "plan")
    ).rejects.toThrow(/No active session/);
  });
});

describe("diffCheckpoint", () => {
  it("reports adds, edits and deletions without needing git", async () => {
    const checkpoint = {
      capturedAt: new Date().toISOString(),
      fileHashes: { "src/a.ts": "h1", "src/b.ts": "h2", "src/gone.ts": "h3" }
    };

    const diff = diffCheckpoint(checkpoint, {
      "src/a.ts": "h1",
      "src/b.ts": "CHANGED",
      "src/new.ts": "h4"
    });

    expect(diff.modified).toEqual(["src/b.ts"]);
    expect(diff.added).toEqual(["src/new.ts"]);
    // A deletion lowers no timestamp, so only the hash set catches it.
    expect(diff.deleted).toEqual(["src/gone.ts"]);
  });
});

describe("checkConstraints", () => {
  it("enforces a confirmed constraint instead of merely requesting it", () => {
    const decisions = [
      {
        id: "d1",
        kind: "constraint" as const,
        statement: "Do not modify InvoiceController — create a new one",
        confirmedAt: new Date().toISOString(),
        enforcement: { forbidPaths: ["src/web/InvoiceController.java"] }
      },
      {
        id: "d2",
        kind: "constraint" as const,
        statement: "Keep the billing module isolated",
        confirmedAt: new Date().toISOString(),
        enforcement: { forbidPaths: ["src/billing"] }
      }
    ];

    const clean = checkConstraints(decisions, ["src/web/OrderController.java"]);
    expect(clean.violations).toEqual([]);

    const breached = checkConstraints(decisions, [
      "src/web/InvoiceController.java",
      "src/billing/Ledger.java",
      "src/web/OrderController.java"
    ]);
    expect(breached.violations.map((v) => v.decisionId)).toEqual(["d1", "d2"]);
    // A directory constraint covers what is under it.
    expect(breached.violations[1].paths).toEqual(["src/billing/Ledger.java"]);
  });

  it("reports an uncheckable constraint rather than counting it as passed", () => {
    // Honest degradation: a constraint with no enforcement is still recorded
    // and still shown, but must not look like it was verified.
    const check = checkConstraints(
      [
        {
          id: "d1",
          kind: "constraint" as const,
          statement: "Keep the change small",
          confirmedAt: new Date().toISOString()
        }
      ],
      ["src/anything.ts"]
    );

    expect(check.violations).toEqual([]);
    expect(check.unenforceable).toEqual([
      { decisionId: "d1", statement: "Keep the change small" }
    ]);
  });

  it("ignores decisions that are not constraints", () => {
    const check = checkConstraints(
      [
        {
          id: "d1",
          kind: "design" as const,
          statement: "Use Kafka",
          confirmedAt: new Date().toISOString()
        }
      ],
      ["src/anything.ts"]
    );

    expect(check.violations).toEqual([]);
    expect(check.unenforceable).toEqual([]);
  });
});

async function createWorkspace(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "copilot-session-"));
}

async function commitAll(repoRoot: string, message: string): Promise<void> {
  await execFileAsync("git", ["add", "."], { cwd: repoRoot });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Copilot Architect",
      "-c",
      "user.email=copilot-architect@example.com",
      "commit",
      "-m",
      message
    ],
    { cwd: repoRoot }
  );
}

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}
