import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_CHANGES,
  parseSelectedChanges,
  parseAddOutlines,
  renderOutline,
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

describe("parseAddOutlines", () => {
  const addPaths = new Set(["src/billing/ApprovalPolicy.ts"]);
  const outlineIndexed = new Set([
    "src/billing/InvoiceService.ts",
    "src/billing/InvoiceState.ts"
  ]);

  it("reads what each export takes, returns and is for", () => {
    // A bare list of names bounds a file's shape and says nothing about what
    // it does, which leaves a developer unable to tell a correct
    // implementation from a plausible one.
    const outlines = parseAddOutlines(
      [
        "file | src/billing/ApprovalPolicy.ts | src/billing/InvoiceService.ts | 80",
        "export | src/billing/ApprovalPolicy.ts | ApprovalPolicy | decide(invoice, approver): ApprovalDecision | applies the approval rules to one invoice",
        "export | src/billing/ApprovalPolicy.ts | ApprovalDecision | { approved, reason } | the outcome, with why it was reached"
      ].join("\n"),
      { addPaths, indexedPaths: outlineIndexed }
    );

    expect(outlines.get("src/billing/ApprovalPolicy.ts")).toEqual({
      exports: [
        {
          name: "ApprovalPolicy",
          signature: "decide(invoice, approver): ApprovalDecision",
          purpose: "applies the approval rules to one invoice"
        },
        {
          name: "ApprovalDecision",
          signature: "{ approved, reason }",
          purpose: "the outcome, with why it was reached"
        }
      ],
      dependsOn: ["src/billing/InvoiceService.ts"],
      estimatedLines: 80
    });
  });

  it("keeps a signature containing commas intact", () => {
    // The reason for two record kinds. Packing exports into one
    // comma-separated field would split every signature down the middle.
    const outlines = parseAddOutlines(
      "export | src/billing/ApprovalPolicy.ts | ApprovalPolicy | decide(invoice, approver, options): ApprovalDecision | applies the rules",
      { addPaths, indexedPaths: outlineIndexed }
    );

    expect(outlines.get("src/billing/ApprovalPolicy.ts")?.exports[0].signature).toBe(
      "decide(invoice, approver, options): ApprovalDecision"
    );
  });

  it("accepts an export with no signature or purpose", () => {
    const outlines = parseAddOutlines(
      "export | src/billing/ApprovalPolicy.ts | ApprovalPolicy | | ",
      { addPaths, indexedPaths: outlineIndexed }
    );

    expect(outlines.get("src/billing/ApprovalPolicy.ts")?.exports).toEqual([
      { name: "ApprovalPolicy" }
    ]);
  });

  it("drops an import of a file that is not in the repository", () => {
    // An outline importing something that does not exist was written about a
    // different repository. Showing it would put a false fact in front of the
    // developer at the moment they are deciding whether to approve.
    const outlines = parseAddOutlines(
      [
        "file | src/billing/ApprovalPolicy.ts | src/billing/Imagined.ts, src/billing/InvoiceState.ts | 60",
        "export | src/billing/ApprovalPolicy.ts | ApprovalPolicy | decide() | applies the rules"
      ].join("\n"),
      { addPaths, indexedPaths: outlineIndexed }
    );

    expect(outlines.get("src/billing/ApprovalPolicy.ts")?.dependsOn).toEqual([
      "src/billing/InvoiceState.ts"
    ]);
  });

  it("ignores records for a file the plan is not adding", () => {
    const outlines = parseAddOutlines(
      [
        "file | src/billing/Unrelated.ts | | 40",
        "export | src/billing/Unrelated.ts | Something | | ",
        "export | src/billing/ApprovalPolicy.ts | ApprovalPolicy | decide() | applies the rules"
      ].join("\n"),
      { addPaths, indexedPaths: outlineIndexed }
    );

    expect([...outlines.keys()]).toEqual(["src/billing/ApprovalPolicy.ts"]);
  });

  it("drops a file record that exports nothing", () => {
    // An outline with nothing in it bounds nothing, and rendering it would
    // imply the add had been thought about when it had not.
    const outlines = parseAddOutlines(
      [
        "file | src/billing/ApprovalPolicy.ts | src/billing/InvoiceService.ts | 60",
        "export | src/billing/ApprovalPolicy.ts | a sentence, not an identifier | | "
      ].join("\n"),
      { addPaths, indexedPaths: outlineIndexed }
    );

    expect(outlines.size).toBe(0);
  });

  it("keeps exports even when no file record came with them", () => {
    // What the file imports and how long it is are useful; what it exposes is
    // the part a developer is approving. Losing that over a missing line
    // would throw away the outline's reason to exist.
    const outlines = parseAddOutlines(
      "export | src/billing/ApprovalPolicy.ts | ApprovalPolicy | decide() | applies the rules",
      { addPaths, indexedPaths: outlineIndexed }
    );

    expect(outlines.get("src/billing/ApprovalPolicy.ts")).toEqual({
      exports: [
        { name: "ApprovalPolicy", signature: "decide()", purpose: "applies the rules" }
      ],
      dependsOn: []
    });
  });

  it("refuses a line count that is not a plausible file", () => {
    const outlineFor = (lines: string) =>
      parseAddOutlines(
        [
          `file | src/billing/ApprovalPolicy.ts | | ${lines}`,
          "export | src/billing/ApprovalPolicy.ts | ApprovalPolicy | decide() | applies the rules"
        ].join("\n"),
        { addPaths, indexedPaths: outlineIndexed }
      ).get("src/billing/ApprovalPolicy.ts");

    expect(outlineFor("99999")?.estimatedLines).toBeUndefined();
    expect(outlineFor("0")?.estimatedLines).toBeUndefined();
    expect(outlineFor("80")?.estimatedLines).toBe(80);
  });

  it("keeps the first description when a file is described twice", () => {
    const outlines = parseAddOutlines(
      [
        "file | src/billing/ApprovalPolicy.ts | | 60",
        "file | src/billing/ApprovalPolicy.ts | | 900",
        "export | src/billing/ApprovalPolicy.ts | ApprovalPolicy | decide() | applies the rules",
        "export | src/billing/ApprovalPolicy.ts | ApprovalPolicy | somethingElse() | a second take"
      ].join("\n"),
      { addPaths, indexedPaths: outlineIndexed }
    );

    const outline = outlines.get("src/billing/ApprovalPolicy.ts");
    expect(outline?.estimatedLines).toBe(60);
    expect(outline?.exports).toHaveLength(1);
    expect(outline?.exports[0].signature).toBe("decide()");
  });

  it("caps the export list", () => {
    const many = Array.from(
      { length: 30 },
      (_, i) =>
        `export | src/billing/ApprovalPolicy.ts | Export${i} | call${i}() | purpose ${i}`
    ).join("\n");

    const outlines = parseAddOutlines(many, {
      addPaths,
      indexedPaths: outlineIndexed
    });

    expect(outlines.get("src/billing/ApprovalPolicy.ts")?.exports).toHaveLength(12);
  });

  it("ignores prose", () => {
    const outlines = parseAddOutlines(
      [
        "Here is what the new file will contain:",
        "It will export an approval policy class."
      ].join("\n"),
      { addPaths, indexedPaths: outlineIndexed }
    );

    expect(outlines.size).toBe(0);
  });
});

describe("renderOutline", () => {
  it("gives each export its own line, with how it is called and why", () => {
    expect(
      renderOutline({
        exports: [
          {
            name: "ApprovalPolicy",
            signature: "decide(invoice, approver): ApprovalDecision",
            purpose: "applies the approval rules to one invoice"
          },
          { name: "ApprovalDecision" }
        ],
        dependsOn: ["src/billing/InvoiceService.ts"],
        estimatedLines: 80
      })
    ).toBe(
      [
        "will export 2, imports src/billing/InvoiceService.ts · ~80 lines",
        "    · **ApprovalPolicy** `decide(invoice, approver): ApprovalDecision` — applies the approval rules to one invoice",
        "    · **ApprovalDecision**"
      ].join("\n")
    );
  });

  it("leaves out what was not said", () => {
    expect(
      renderOutline({ exports: [{ name: "ApprovalPolicy" }], dependsOn: [] })
    ).toBe(["will export 1", "    · **ApprovalPolicy**"].join("\n"));
  });

  it("returns nothing when there is no outline", () => {
    expect(renderOutline(undefined)).toBeUndefined();
  });
});
