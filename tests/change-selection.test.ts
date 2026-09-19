import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_CHANGES,
  parseSelectedChanges,
  selectByRelevance,
  verifySelectedChanges
} from "../packages/planner/src/index.js";

const candidates = [
  "src/billing/InvoiceService.ts",
  "src/billing/InvoiceService.test.ts",
  "docs/billing.md"
];

const indexedPaths = new Set(candidates);

describe("parseSelectedChanges", () => {
  it("reads a selection with a reason for each file", () => {
    const selected = parseSelectedChanges(
      [
        "update | src/billing/InvoiceService.ts | holds the invoice lifecycle this hooks into",
        "add | src/billing/ApprovalPolicy.ts | new rules deciding who may approve"
      ].join("\n"),
      { candidates, indexedPaths }
    );

    expect(selected).toEqual([
      {
        kind: "update",
        relativePath: "src/billing/InvoiceService.ts",
        rationale: "holds the invoice lifecycle this hooks into"
      },
      {
        kind: "add",
        relativePath: "src/billing/ApprovalPolicy.ts",
        rationale: "new rules deciding who may approve"
      }
    ]);
  });

  it("reads the symbol a reason rests on", () => {
    const selected = parseSelectedChanges(
      [
        "update | src/billing/InvoiceService.ts | holds the invoice lifecycle | InvoiceService",
        "update | docs/billing.md | describes the flow | `InvoiceState.approved`",
        "add | src/billing/ApprovalPolicy.ts | new approval rules |"
      ].join("\n"),
      { candidates, indexedPaths }
    );

    expect(selected.map((change) => change.evidenceSymbol)).toEqual([
      "InvoiceService",
      // Qualified: the type is what the index records as a symbol.
      "InvoiceState",
      undefined
    ]);
  });

  it("ignores a citation that is prose rather than a symbol", () => {
    // A phrase verifies against nothing and would report every row as
    // unconfirmed, which is how a warning stops being read.
    const selected = parseSelectedChanges(
      [
        "update | src/billing/InvoiceService.ts | holds the lifecycle | the invoice service class",
        "update | docs/billing.md | describes the flow | src/billing/InvoiceService.ts"
      ].join("\n"),
      { candidates, indexedPaths }
    );

    expect(selected.every((change) => change.evidenceSymbol === undefined)).toBe(true);
  });

  it("leaves out related files the model did not select", () => {
    // The whole point. Being related is not a reason to change: the test and
    // the doc rank highly for "invoice" and need no edit.
    const selected = parseSelectedChanges(
      "update | src/billing/InvoiceService.ts | the approval hook belongs here",
      { candidates, indexedPaths }
    );

    expect(selected.map((change) => change.relativePath)).toEqual([
      "src/billing/InvoiceService.ts"
    ]);
  });

  it("drops an update naming a file the index has never seen", () => {
    // A path nobody has read cannot be snapshotted, so implementation would
    // patch blind. Dropping it is the only safe reading.
    const selected = parseSelectedChanges(
      [
        "update | src/billing/Imagined.ts | invented by the model",
        "delete | src/nowhere/Gone.ts | also invented"
      ].join("\n"),
      { candidates, indexedPaths }
    );

    expect(selected).toEqual([]);
  });

  it("treats an add of an existing file as an update", () => {
    // Unambiguous: you cannot add what is there. Dropping it would silently
    // lose a file the model judged necessary.
    const selected = parseSelectedChanges(
      "add | src/billing/InvoiceService.ts | needs the approval state machine",
      { candidates, indexedPaths }
    );

    expect(selected[0].kind).toBe("update");
  });

  it("refuses a path that escapes the repository", () => {
    // Refused here, not at write time: a developer should never be shown a
    // plan proposing to write outside their repo, even one that would later
    // be blocked.
    const selected = parseSelectedChanges(
      [
        "add | ../../etc/passwd | absolutely not",
        "add | /etc/hosts | nor this",
        "add | C:/Windows/system32/drivers/etc/hosts | nor this",
        "update | src/../../escape.ts | nor this"
      ].join("\n"),
      { candidates, indexedPaths }
    );

    expect(selected).toEqual([]);
  });

  it("normalizes a path a model wrote in Windows form", () => {
    const selected = parseSelectedChanges(
      "add | src\\billing\\ApprovalPolicy.ts | new approval rules",
      { candidates, indexedPaths }
    );

    expect(selected[0].relativePath).toBe("src/billing/ApprovalPolicy.ts");
  });

  it("requires a reason worth reading", () => {
    // "needed" is not a rationale. The plan is the reviewable artifact; a
    // reason a reviewer cannot weigh is noise in it.
    const selected = parseSelectedChanges(
      [
        "update | src/billing/InvoiceService.ts | needed",
        "update | src/billing/InvoiceService.ts |",
        "update | src/billing/InvoiceService.ts"
      ].join("\n"),
      { candidates, indexedPaths }
    );

    expect(selected).toEqual([]);
  });

  it("ignores prose and keeps the lines that parse", () => {
    const selected = parseSelectedChanges(
      [
        "Here is my selection:",
        "1. We should change the invoice service",
        "update | src/billing/InvoiceService.ts | the approval hook belongs here",
        "rename | docs/billing.md | not a change kind"
      ].join("\n"),
      { candidates, indexedPaths }
    );

    expect(selected).toHaveLength(1);
    expect(selected[0].relativePath).toBe("src/billing/InvoiceService.ts");
  });

  it("does not select the same file twice", () => {
    const selected = parseSelectedChanges(
      [
        "update | src/billing/InvoiceService.ts | the approval hook belongs here",
        "delete | src/billing/InvoiceService.ts | changed my mind entirely"
      ].join("\n"),
      { candidates, indexedPaths }
    );

    expect(selected).toHaveLength(1);
    expect(selected[0].kind).toBe("update");
  });

  it("caps the selection so a plan stays reviewable", () => {
    const many = Array.from(
      { length: 30 },
      (_, i) => `add | src/generated/File${i}.ts | a generated file number ${i}`
    ).join("\n");

    expect(parseSelectedChanges(many, { candidates, indexedPaths })).toHaveLength(
      DEFAULT_MAX_CHANGES
    );
  });
});

describe("selectByRelevance", () => {
  it("falls back to the top candidates as updates", () => {
    const selected = selectByRelevance(candidates, () => ["lexical", "structural"], 2);

    expect(selected).toEqual([
      {
        kind: "update",
        relativePath: "src/billing/InvoiceService.ts",
        rationale: "Matched on lexical, structural"
      },
      {
        kind: "update",
        relativePath: "src/billing/InvoiceService.test.ts",
        rationale: "Matched on lexical, structural"
      }
    ]);
  });

  it("says something useful when a candidate carries no signals", () => {
    const selected = selectByRelevance(["src/a.ts"], () => [], 1);
    expect(selected[0].rationale).toBe("Matched on keyword relevance");
  });
});

describe("verifySelectedChanges", () => {
  const symbolsByFile = new Map([
    ["src/billing/InvoiceService.ts", new Set(["InvoiceService", "InvoiceState"])],
    ["src/billing/empty.ts", new Set<string>()]
  ]);

  it("verifies a reason built on a symbol the file declares", () => {
    const [change] = verifySelectedChanges(
      [
        {
          kind: "update",
          relativePath: "src/billing/InvoiceService.ts",
          rationale: "holds the invoice lifecycle this hooks into",
          evidenceSymbol: "InvoiceService"
        }
      ],
      symbolsByFile
    );

    expect(change.evidence).toBe("verified");
    expect(change.evidenceReason).toBeUndefined();
  });

  it("flags a reason built on a symbol that is not there", () => {
    // The failure this exists for: a real file with a confident explanation
    // that belongs to some other file entirely. Harder to spot than the
    // "Matched on lexical, structural" it replaced.
    const [change] = verifySelectedChanges(
      [
        {
          kind: "update",
          relativePath: "src/billing/InvoiceService.ts",
          rationale: "owns the approval state machine",
          evidenceSymbol: "ApprovalStateMachine"
        }
      ],
      symbolsByFile
    );

    expect(change.evidence).toBe("unverified");
    expect(change.evidenceReason).toContain("not declared in this file");
  });

  it("never drops a change, whatever the verdict", () => {
    // The plan is the reviewable artifact and the developer is the final
    // decider. A wrong reason on a right file must not remove the file.
    const verified = verifySelectedChanges(
      [
        {
          kind: "update",
          relativePath: "src/billing/InvoiceService.ts",
          rationale: "owns the approval state machine",
          evidenceSymbol: "Nonexistent"
        },
        {
          kind: "add",
          relativePath: "src/billing/ApprovalPolicy.ts",
          rationale: "new rules deciding who may approve"
        }
      ],
      symbolsByFile
    );

    expect(verified).toHaveLength(2);
  });

  it("does not check an add, which has no file to check against", () => {
    const [change] = verifySelectedChanges(
      [
        {
          kind: "add",
          relativePath: "src/billing/ApprovalPolicy.ts",
          rationale: "new rules deciding who may approve",
          evidenceSymbol: "ApprovalPolicy"
        }
      ],
      symbolsByFile
    );

    expect(change.evidence).toBe("not-checked");
    expect(change.evidenceReason).toContain("new file");
  });

  it("reports no citation as unchecked, not as wrong", () => {
    // "Could not check" and "checked and false" are different states, and
    // showing the second when the first is true is how a warning stops
    // meaning anything.
    const [change] = verifySelectedChanges(
      [
        {
          kind: "update",
          relativePath: "src/billing/InvoiceService.ts",
          rationale: "holds the invoice lifecycle this hooks into"
        }
      ],
      symbolsByFile
    );

    expect(change.evidence).toBe("not-checked");
    expect(change.evidenceReason).toContain("no symbol was cited");
  });

  it("does not call a file with no indexed symbols a fabrication", () => {
    // Plenty of real files declare nothing the indexer recognizes. Reporting
    // those as unverified would bury the real findings.
    const [change] = verifySelectedChanges(
      [
        {
          kind: "update",
          relativePath: "src/billing/empty.ts",
          rationale: "carries the configuration this reads",
          evidenceSymbol: "Anything"
        }
      ],
      symbolsByFile
    );

    expect(change.evidence).toBe("not-checked");
    expect(change.evidenceReason).toContain("no symbols are indexed");
  });

  it("treats a file missing from the map as unchecked", () => {
    const [change] = verifySelectedChanges(
      [
        {
          kind: "delete",
          relativePath: "src/billing/Unknown.ts",
          rationale: "superseded by the new approval policy",
          evidenceSymbol: "Unknown"
        }
      ],
      symbolsByFile
    );

    expect(change.evidence).toBe("not-checked");
  });
});
