import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  GroundingService,
  extractClaims,
  summarizeGrounding
} from "../packages/grounding/src/index.js";

describe("extractClaims", () => {
  it("ignores prose, however code-like it looks", () => {
    // The precision requirement. "Spring" and "React" are PascalCase words
    // that will never be in an index; flagging them would bury real findings
    // under noise a developer learns to scroll past.
    const claims = extractClaims(
      "This is a Spring Boot service using React on the frontend, backed by Kafka. " +
        "OrderService handles placement and BillingProcessor invoices."
    );

    expect(claims).toEqual([]);
  });

  it("picks up paths, citations and qualified symbols in backticks", () => {
    const claims = extractClaims(
      "See `src/OrderService.java:42` — it calls `OrderValidator.validate()` " +
        "and the config lives in `src/main/resources/application.yml`. " +
        "The `npm test` command runs it."
    );

    expect(claims).toEqual([
      {
        kind: "citation",
        text: "src/OrderService.java:42",
        path: "src/OrderService.java",
        line: 42
      },
      {
        kind: "symbol",
        text: "OrderValidator.validate()",
        symbol: "OrderValidator"
      },
      {
        kind: "file",
        text: "src/main/resources/application.yml",
        path: "src/main/resources/application.yml"
      }
    ]);
    // `npm test` is backticked but is not a path or a qualified symbol.
    expect(claims.map((claim) => claim.text)).not.toContain("npm test");
  });

  it("does not report the same claim twice", () => {
    const claims = extractClaims("`src/a.ts` and again `src/a.ts`");
    expect(claims).toHaveLength(1);
  });
});

describe("GroundingService", () => {
  it("catches a cited file that does not exist", async () => {
    const startPath = await createRepo({
      "src/OrderService.ts": "export class OrderService { place() {} }"
    });

    const report = await new GroundingService().verify(
      "The logic is in `src/OrderService.ts`, with a helper in `src/InvoiceReconciler.ts`.",
      { startPath }
    );

    expect(report.verified.map((r) => r.claim.text)).toEqual(["src/OrderService.ts"]);
    expect(report.unverified.map((r) => r.claim.text)).toEqual([
      "src/InvoiceReconciler.ts"
    ]);
    expect(report.unverified[0].reason).toContain("no such file");
  });

  it("catches a line citation past the end of the file", async () => {
    // One of the cheapest hallucinations to catch, and one that reads as
    // entirely authoritative on the page.
    const startPath = await createRepo({
      "src/small.ts": "export const a = 1;\nexport const b = 2;"
    });

    const report = await new GroundingService().verify(
      "Defined at `src/small.ts:2`, and again at `src/small.ts:900`.",
      { startPath }
    );

    expect(report.verified.map((r) => r.claim.text)).toEqual(["src/small.ts:2"]);
    expect(report.unverified[0].claim.text).toBe("src/small.ts:900");
    expect(report.unverified[0].reason).toContain("past the end of the file");
  });

  it("catches a symbol that is not indexed", async () => {
    const startPath = await createRepo({
      "src/OrderService.ts": "export class OrderService { place() {} }"
    });

    const report = await new GroundingService().verify(
      "`OrderService.place()` calls `InvoiceReconciler.settle()`.",
      { startPath }
    );

    expect(report.verified.map((r) => r.claim.symbol)).toEqual(["OrderService"]);
    expect(report.unverified.map((r) => r.claim.symbol)).toEqual(["InvoiceReconciler"]);
  });

  it("checks symbols against the uncapped index, not the display view", async () => {
    // Regression: the file inventory caps symbols per file for display, and
    // verifying against that truncated list reported real symbols as missing.
    // A false warning is far more damaging than a missed one — it teaches a
    // developer to ignore the warnings entirely.
    const manySymbols = Array.from(
      { length: 40 },
      (_, i) => `export function helper${String.fromCharCode(65 + i)}() {}`
    ).join("\n");
    const startPath = await createRepo({
      "src/big.ts": `${manySymbols}\nexport class LastDeclared {}`
    });

    const report = await new GroundingService().verify(
      "See `LastDeclared.run()` in `src/big.ts`.",
      { startPath }
    );

    // Declared past the display cap, but real.
    expect(report.unverified).toEqual([]);
    expect(report.verified.map((r) => r.claim.text)).toContain("LastDeclared.run()");
  });

  it("says nothing was verified rather than returning a clean report", async () => {
    // An empty report from a missing index would read as "all clear", which is
    // the same failure as an empty context reading as "the repo is empty".
    const startPath = await mkdtemp(path.join(tmpdir(), "copilot-ground-empty-"));

    const report = await new GroundingService().verify("`src/a.ts` exists.", {
      startPath
    });

    expect(report.verified).toEqual([]);
    expect(report.unverified).toEqual([]);
    expect(report.notChecked.join(" ")).toContain("no index");
  });

  it("always states what it did not check", async () => {
    const startPath = await createRepo({ "src/a.ts": "export const a = 1;" });

    const report = await new GroundingService().verify("All good in `src/a.ts`.", {
      startPath
    });

    expect(report.unverified).toEqual([]);
    // A clean pass must not be mistaken for a complete one.
    expect(report.notChecked.join(" ")).toContain(
      "Statements in prose are not checked"
    );
  });
});

describe("summarizeGrounding", () => {
  it("stays silent when everything checked out", () => {
    expect(
      summarizeGrounding({ verified: [], unverified: [], notChecked: [] })
    ).toBeUndefined();
  });

  it("names each unverified claim and why", () => {
    const summary = summarizeGrounding({
      verified: [],
      unverified: [
        {
          claim: { kind: "file", text: "src/ghost.ts", path: "src/ghost.ts" },
          status: "unverified",
          reason: "no such file in the index"
        }
      ],
      notChecked: []
    });

    expect(summary).toContain("src/ghost.ts");
    expect(summary).toContain("no such file in the index");
    expect(summary).toContain("unconfirmed");
  });
});

async function createRepo(files: Record<string, string>): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-ground-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }

  return repoRoot;
}
