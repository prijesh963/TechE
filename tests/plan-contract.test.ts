import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  planValidationCommands,
  buildPlannedChange,
  createPlanContract,
  extractExcerpt,
  plannedPaths,
  readApprovedPlan,
  verifyPlanFreshness,
  writeApprovedPlan
} from "../packages/planner/src/index.js";
import type { Decision } from "../packages/session/src/index.js";

describe("extractExcerpt", () => {
  it("returns a window around the anchor, not the whole file", () => {
    // Whole files would make a twenty-file plan the expensive prompt this
    // design exists to avoid; a bare path would make the plan useless without
    // re-reading the repo.
    const text = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");

    const excerpt = extractExcerpt(text, 100, 5);

    expect(excerpt.startLine).toBe(95);
    expect(excerpt.endLine).toBe(105);
    expect(excerpt.fileLines).toBe(200);
    expect(excerpt.text.split("\n")).toHaveLength(11);
    expect(excerpt.text.startsWith("line 95")).toBe(true);
    expect(excerpt.text.endsWith("line 105")).toBe(true);
  });

  it("clamps at both ends of the file", () => {
    const text = "one\ntwo\nthree";

    expect(extractExcerpt(text, 1, 10)).toMatchObject({
      startLine: 1,
      endLine: 3,
      text: "one\ntwo\nthree"
    });
    expect(extractExcerpt(text, 3, 1)).toMatchObject({ startLine: 2, endLine: 3 });
    // No anchor means the top of the file rather than an error.
    expect(extractExcerpt(text).startLine).toBe(1);
  });
});

describe("buildPlannedChange", () => {
  it("extracts the before code from disk rather than accepting it", async () => {
    // The point of the whole module: a model asked to reproduce existing code
    // paraphrases it, and a paraphrase applied as a patch corrupts the file.
    // There is deliberately no API to pass `before` text in.
    const repoRoot = await createRepo({
      "src/OrderService.java":
        "package com.acme;\npublic class OrderService {\n  public void place() {}\n}"
    });

    const change = await buildPlannedChange({
      repoRoot,
      relativePath: "src/OrderService.java",
      kind: "update",
      rationale: "Add approval step",
      anchorLine: 3
    });

    expect(change.before?.text).toContain("public void place() {}");
    // Byte-for-byte what is on disk.
    expect(change.before?.text).toBe(
      await readFile(path.join(repoRoot, "src/OrderService.java"), "utf8")
    );
    expect(change.beforeHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("quotes nothing for a new file", async () => {
    const repoRoot = await createRepo({ "src/existing.ts": "export const a = 1;" });

    const change = await buildPlannedChange({
      repoRoot,
      relativePath: "src/brand-new.ts",
      kind: "add",
      rationale: "New approval handler"
    });

    expect(change.before).toBeUndefined();
    expect(change.beforeHash).toBeUndefined();
    expect(change.outline).toBeUndefined();
  });

  it("carries an approved outline on a new file", async () => {
    // An add has no snapshot to quote, so the outline is what the developer
    // actually approved — and what implementation is held to.
    const repoRoot = await createRepo({ "src/existing.ts": "export const a = 1;" });

    const change = await buildPlannedChange({
      repoRoot,
      relativePath: "src/brand-new.ts",
      kind: "add",
      rationale: "New approval handler",
      outline: {
        exports: [
          {
            name: "ApprovalHandler",
            signature: "handle(invoice): ApprovalDecision",
            purpose: "applies the approval rules to one invoice"
          }
        ],
        dependsOn: ["src/existing.ts"],
        estimatedLines: 60
      }
    });

    expect(change.before).toBeUndefined();
    // Signature and purpose survive into the artifact, because they are what
    // the developer read before approving — a name alone leaves them unable
    // to tell a correct implementation from a plausible one.
    expect(change.outline).toEqual({
      exports: [
        {
          name: "ApprovalHandler",
          signature: "handle(invoice): ApprovalDecision",
          purpose: "applies the approval rules to one invoice"
        }
      ],
      dependsOn: ["src/existing.ts"],
      estimatedLines: 60
    });
  });

  it("ignores an outline on a file that already exists", async () => {
    // An update shows real code; an outline there would be a second, weaker
    // description of the same file competing with the snapshot.
    const repoRoot = await createRepo({ "src/existing.ts": "export const a = 1;" });

    const change = await buildPlannedChange({
      repoRoot,
      relativePath: "src/existing.ts",
      kind: "update",
      rationale: "holds the value this changes",
      outline: { exports: [{ name: "Nonsense" }], dependsOn: [] }
    });

    expect(change.outline).toBeUndefined();
    expect(change.before).toBeDefined();
  });

  it("records the change without a snapshot when the file cannot be read", async () => {
    // Better than a plan that quotes a file which is not there: the freshness
    // check will refuse rather than let implementation patch blind.
    const repoRoot = await createRepo({ "src/a.ts": "export const a = 1;" });

    const change = await buildPlannedChange({
      repoRoot,
      relativePath: "src/does-not-exist.ts",
      kind: "update",
      rationale: "Update it"
    });

    expect(change.kind).toBe("update");
    expect(change.before).toBeUndefined();
    expect(change.beforeHash).toBeUndefined();
  });
});

describe("verifyPlanFreshness", () => {
  it("catches a file that moved under the plan", async () => {
    const repoRoot = await createRepo({
      "src/a.ts": "export const a = 1;",
      "src/b.ts": "export const b = 2;"
    });
    const plan = createPlanContract({
      request: "Add invoice approval",
      version: 1,
      decisions: [],
      changes: [
        await buildPlannedChange({
          repoRoot,
          relativePath: "src/a.ts",
          kind: "update",
          rationale: "x"
        }),
        await buildPlannedChange({
          repoRoot,
          relativePath: "src/b.ts",
          kind: "update",
          rationale: "y"
        })
      ]
    });

    expect((await verifyPlanFreshness(plan, repoRoot)).ok).toBe(true);

    await writeFile(path.join(repoRoot, "src/b.ts"), "export const b = 999;", "utf8");
    await rm(path.join(repoRoot, "src/a.ts"));

    const freshness = await verifyPlanFreshness(plan, repoRoot);
    expect(freshness.drifted).toEqual(["src/b.ts"]);
    expect(freshness.missing).toEqual(["src/a.ts"]);
    expect(freshness.ok).toBe(false);
  });

  it("ignores additions, which quote nothing to drift from", async () => {
    const repoRoot = await createRepo({ "src/a.ts": "export const a = 1;" });
    const plan = createPlanContract({
      request: "Add handler",
      version: 1,
      decisions: [],
      changes: [
        await buildPlannedChange({
          repoRoot,
          relativePath: "src/new.ts",
          kind: "add",
          rationale: "new"
        })
      ]
    });

    expect((await verifyPlanFreshness(plan, repoRoot)).ok).toBe(true);
  });
});

describe("approved plan artifacts", () => {
  it("writes only on approval, and keeps every version", async () => {
    // Reverses the old order, where a plan was written first and marked
    // approved afterwards. A draft now lives in the session and nowhere else.
    const workspaceRoot = await createRepo({ "src/a.ts": "export const a = 1;" });
    const decisions: Decision[] = [
      {
        id: "d1",
        kind: "design",
        statement: "Use Kafka",
        rejected: "synchronous REST",
        confirmedAt: new Date().toISOString()
      }
    ];

    const v1 = createPlanContract({
      request: "Add invoice approval",
      version: 1,
      decisions,
      changes: [
        await buildPlannedChange({
          repoRoot: workspaceRoot,
          relativePath: "src/a.ts",
          kind: "update",
          rationale: "x"
        })
      ],
      validation: [{ command: "npm test", cwd: workspaceRoot }]
    });
    await writeApprovedPlan(workspaceRoot, v1);

    const v2 = createPlanContract({
      request: "Add invoice approval",
      version: 2,
      decisions,
      changes: [],
      notes: ["Reviewer asked for an idempotency key"]
    });
    await writeApprovedPlan(workspaceRoot, v2);

    // Latest is v2, but v1 is still readable — a review round is only
    // comparable against the version before it.
    expect((await readApprovedPlan(workspaceRoot))?.version).toBe(2);
    expect((await readApprovedPlan(workspaceRoot, 1))?.version).toBe(1);
    expect(await readApprovedPlan(workspaceRoot, 9)).toBeUndefined();

    // The decisions travel with the plan, so it can be reviewed by someone who
    // never saw the session.
    const stored = await readApprovedPlan(workspaceRoot, 1);
    expect(stored?.decisions[0]?.rejected).toBe("synchronous REST");
    expect(stored?.validation[0]?.command).toBe("npm test");
  });

  it("lists planned paths with their repo, for constraint checking", async () => {
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
        },
        { kind: "add", relativePath: "src/New.java", rationale: "y" }
      ]
    });

    expect(plannedPaths(plan)).toEqual(["src/New.java", "svc-billing/src/Ledger.java"]);
  });
});

async function createRepo(files: Record<string, string>): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-plan-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }

  return repoRoot;
}

describe("planValidationCommands", () => {
  it("keeps the arguments, so the command actually runs the tests", () => {
    // Reported from a real run: a plan committed to "./mvnw, mvn". Adapters
    // record the executable and its arguments separately, and taking the
    // executable alone produces a command that prints usage and tests
    // nothing.
    const commands = planValidationCommands({
      repos: [
        {
          root: "/repo",
          commands: {
            test: [{ name: "./mvnw test", command: "./mvnw", args: ["test"] }],
            lint: [{ name: "npm run lint", command: "npm", args: ["run", "lint"] }]
          }
        }
      ]
    });

    expect(commands).toEqual([
      { command: "./mvnw test", cwd: "/repo" },
      { command: "npm run lint", cwd: "/repo" }
    ]);
  });

  it("falls back to executable and args when there is no readable name", () => {
    const commands = planValidationCommands({
      repos: [{ commands: { test: [{ command: "mvn", args: ["test"] }] } }]
    });

    expect(commands).toEqual([{ command: "mvn test" }]);
  });

  it("ignores a name that is a label rather than the command", () => {
    // A name that does not start with the executable would run as something
    // else entirely.
    const commands = planValidationCommands({
      repos: [
        {
          commands: {
            test: [{ name: "Unit tests (fast)", command: "mvn", args: ["test"] }]
          }
        }
      ]
    });

    expect(commands).toEqual([{ command: "mvn test" }]);
  });

  it("commits a plan to the tests and lint the repo already has", () => {
    // PlanContract.validation existed from the start and was never populated,
    // so every plan carried an empty list and the validator package was
    // unreachable from the product's main path.
    const commands = planValidationCommands({
      repos: [
        {
          root: "/repo",
          commands: {
            test: [{ command: "npm", args: ["test"] }],
            lint: [{ command: "npm", args: ["run", "lint"] }],
            build: [{ command: "npm", args: ["run", "build"] }]
          }
        }
      ]
    });

    expect(commands).toEqual([
      { command: "npm test", cwd: "/repo" },
      { command: "npm run lint", cwd: "/repo" }
    ]);
  });

  it("leaves out build, which is slow enough that a plan committing to it gets skipped", () => {
    const commands = planValidationCommands({
      repos: [{ commands: { build: [{ command: "npm run build" }] } }]
    });

    expect(commands).toEqual([]);
  });

  it("does not repeat a command shared by two repos", () => {
    const commands = planValidationCommands({
      repos: [
        { root: "/a", commands: { test: [{ command: "npm test" }] } },
        { root: "/b", commands: { test: [{ command: "npm test" }] } }
      ]
    });

    expect(commands).toHaveLength(1);
  });

  it("caps the list so a plan commits to checks, not a build pipeline", () => {
    const commands = planValidationCommands({
      repos: [
        {
          commands: {
            test: Array.from({ length: 10 }, (_, i) => ({ command: `test-${i}` }))
          }
        }
      ]
    });

    expect(commands).toHaveLength(4);
  });

  it("returns nothing rather than throwing on a missing or malformed repo map", () => {
    expect(planValidationCommands(undefined)).toEqual([]);
    expect(planValidationCommands({})).toEqual([]);
    expect(planValidationCommands({ repos: "not an array" })).toEqual([]);
    expect(planValidationCommands({ repos: [{ commands: { test: [{}] } }] })).toEqual(
      []
    );
  });
});

describe("what a plan says it will do", () => {
  it("carries the approved steps on the change", async () => {
    // The rationale says why a file is in scope. Without this the plan never
    // says what happens to it, and approving it is approving a file list.
    const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-intent-"));
    await writeFile(path.join(repoRoot, "UserService.java"), "class A {}\n", "utf8");

    const change = await buildPlannedChange({
      repoRoot,
      relativePath: "UserService.java",
      kind: "update",
      rationale: "this is where passwords are compared",
      intent: ["add hashPassword(String)", "call it from create()"]
    });

    expect(change.intent).toEqual([
      "add hashPassword(String)",
      "call it from create()"
    ]);
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("leaves intent off a change that has none", async () => {
    // Absent rather than empty: an empty list would read as "nothing to do
    // here", which is a different claim from "nothing was asked".
    const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-intent-none-"));
    await writeFile(path.join(repoRoot, "UserService.java"), "class A {}\n", "utf8");

    const change = await buildPlannedChange({
      repoRoot,
      relativePath: "UserService.java",
      kind: "update",
      rationale: "this is where passwords are compared",
      intent: []
    });

    expect(change.intent).toBeUndefined();
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("carries the overall approach on the contract", () => {
    const plan = createPlanContract({
      request: "hash passwords",
      version: 1,
      decisions: [],
      changes: [],
      approach: ["Hash on write, verify on login."]
    });

    expect(plan.approach).toEqual(["Hash on write, verify on login."]);
  });

  it("omits the approach when none was produced", () => {
    const plan = createPlanContract({
      request: "hash passwords",
      version: 1,
      decisions: [],
      changes: []
    });

    expect(plan.approach).toBeUndefined();
  });
});
