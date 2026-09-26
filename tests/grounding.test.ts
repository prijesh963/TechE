import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  GroundingService,
  extractClaims,
  resolveClaimedPath,
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

  it("reads a call written in prose, without backticks", () => {
    // Reported: a security finding claiming "the authenticationManager()
    // method is exposed as a bean" was written without backticks, sailed past
    // a check that read only backticked spans, and became a plan against a
    // method the repository does not have.
    const claims = extractClaims(
      "The authenticationManager() method is exposed as a bean."
    );

    expect(claims).toEqual([
      {
        kind: "symbol",
        text: "authenticationManager()",
        symbol: "authenticationManager"
      }
    ]);
  });

  it("reads a qualified call in prose", () => {
    const claims = extractClaims("It calls OrderService.place() from the controller.");

    expect(claims).toEqual([
      { kind: "symbol", text: "OrderService.place()", symbol: "OrderService" }
    ]);
  });

  it("leaves a parenthetical aside alone", () => {
    // The parenthesis has to follow the name directly. "the docs (below)" is
    // English; `docs()` is code.
    expect(extractClaims("See the docs (below) and the notes (above).")).toEqual([]);
  });

  it("ignores keywords and very short names", () => {
    // `if()`, `it()` and friends are noise, and a false warning costs more
    // than a missed one.
    expect(extractClaims("Use if() and for() and it() carefully.")).toEqual([]);
  });

  it("treats a backticked bare call as the same claim", () => {
    // Backticking must not make a call less checked than writing it in prose,
    // which is what happened while only qualified symbols were read.
    const claims = extractClaims("The `validate()` helper runs first.");

    expect(claims).toEqual([
      { kind: "symbol", text: "validate()", symbol: "validate" }
    ]);
  });

  it("does not report the same claim twice", () => {
    const claims = extractClaims("`src/a.ts` and again `src/a.ts`");
    expect(claims).toHaveLength(1);
  });
});

describe("resolveClaimedPath", () => {
  // The workspace keys files by repo; nobody writing about the code does.
  const indexed = new Set([
    "acme-customers-service/src/main/java/com/acme/customers/CustomersServiceApplication.java",
    "acme-customers-service/pom.xml",
    "acme-billing-service/src/main/java/com/acme/billing/BillingServiceApplication.java",
    "acme-billing-service/pom.xml",
    "acme-shipping-service/pom.xml"
  ]);

  it("resolves a path written relative to its own repo", () => {
    // The regression: eight true claims flagged as fabrications on the first
    // real question anyone asked, because the model wrote the path the way
    // the repository itself does.
    expect(
      resolveClaimedPath(
        "src/main/java/com/acme/customers/CustomersServiceApplication.java",
        indexed
      )
    ).toEqual({
      kind: "exact",
      path: "acme-customers-service/src/main/java/com/acme/customers/CustomersServiceApplication.java"
    });
  });

  it("takes an exact workspace path as it stands", () => {
    expect(resolveClaimedPath("acme-billing-service/pom.xml", indexed)).toEqual({
      kind: "exact",
      path: "acme-billing-service/pom.xml"
    });
  });

  it("refuses to pick one of several matches", () => {
    // `pom.xml` is real in three places here. Verifying one of them would be
    // a fabrication of its own, and calling it missing would be a lie.
    expect(resolveClaimedPath("pom.xml", indexed)).toEqual({
      kind: "ambiguous",
      matches: 3
    });
  });

  it("matches only on a segment boundary", () => {
    // `ServiceApplication.java` must not match `CustomersServiceApplication.java`
    // — a different file with a similar ending.
    expect(resolveClaimedPath("ServiceApplication.java", indexed)).toEqual({
      kind: "missing"
    });
  });

  it("reports a path that is nowhere as missing", () => {
    expect(resolveClaimedPath("src/main/java/Imagined.java", indexed)).toEqual({
      kind: "missing"
    });
  });

  it("does not match a prefix", () => {
    expect(resolveClaimedPath("acme-billing-service/src", indexed)).toEqual({
      kind: "missing"
    });
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

  it("indexes a symbol declared past the old 100-symbol storage cap", async () => {
    // Regression: extraction itself capped a file at 100 symbols before
    // storage, so a real method declared past that point never made it into
    // the index at all — "uncapped" reads like symbolNames() only see what
    // got stored, and reported it as fabricated no matter how it was read.
    const manyMethods = Array.from(
      { length: 150 },
      (_, i) => `  public void method${i}() {}`
    ).join("\n");
    const startPath = await createRepo({
      "src/Big.java": `public class Big {\n${manyMethods}\n  public void lastMethod() {}\n}`
    });

    const report = await new GroundingService().verify(
      "See `lastMethod()` in `src/Big.java`.",
      { startPath }
    );

    expect(report.unverified).toEqual([]);
    expect(report.verified.map((r) => r.claim.text)).toContain("lastMethod()");
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
    expect(report.notChecked.join(" ")).toContain("beyond paths, citations and calls");
  });
});

describe("GroundingService across a multi-repo workspace", () => {
  it("verifies a path written the way the repository writes it", async () => {
    // Reproduces the reported failure on a multi-service Java workspace: a
    // correct answer citing eight real files, every one flagged as a
    // fabrication because the index keys them by repo and the model did not.
    const workspaceRoot = await createWorkspace({
      "customers-service": {
        "src/main/java/com/acme/customers/CustomersServiceApplication.java":
          "package com.acme.customers;\npublic class CustomersServiceApplication {}\n",
        "pom.xml": "<project/>\n"
      },
      "vets-service": {
        "src/main/java/com/acme/billing/BillingServiceApplication.java":
          "package com.acme.billing;\npublic class BillingServiceApplication {}\n",
        "pom.xml": "<project/>\n"
      }
    });

    const report = await new GroundingService().verify(
      "Entry points are `src/main/java/com/acme/customers/CustomersServiceApplication.java` " +
        "and `src/main/java/com/acme/billing/BillingServiceApplication.java`.",
      { startPath: workspaceRoot }
    );

    expect(report.unverified).toEqual([]);
    expect(report.verified).toHaveLength(2);
  });

  it("says a path shared by several repos is ambiguous, not missing", async () => {
    // The cost of resolving by suffix: `src/main/resources/application.yml`
    // is real in every service. Picking one would be a fabrication; calling
    // it missing would be a lie. It says which it is.
    const workspaceRoot = await createWorkspace({
      "customers-service": { "src/main/resources/application.yml": "server:\n" },
      "vets-service": { "src/main/resources/application.yml": "server:\n" }
    });

    const report = await new GroundingService().verify(
      "Each service is configured in `src/main/resources/application.yml`.",
      { startPath: workspaceRoot }
    );

    expect(report.unverified[0].reason).toContain("matches 2 files");
    expect(report.unverified[0].reason).not.toContain("no such file");
  });
});

describe("checking a request's own premise", () => {
  it("catches a request about a method the repository does not have", async () => {
    // The end-to-end failure: /analyze invented "the authenticationManager()
    // method is exposed as a bean" for a repo with no Spring Security, and
    // /create-plan built a plan on it, selecting whatever scored least badly.
    const startPath = await createRepo({
      "src/main/java/com/acme/InvoiceService.java":
        "package com.acme;\npublic class InvoiceService { public void addInvoice() {} }\n"
    });

    const report = await new GroundingService().verify(
      "Draft a plan for: the authenticationManager() method is exposed as a bean and could be misused.",
      { startPath }
    );

    expect(report.unverified.map((result) => result.claim.symbol)).toEqual([
      "authenticationManager"
    ]);
    expect(report.unverified[0].reason).toContain("no symbol with that name");
  });

  it("does not flag a request to create something new", async () => {
    // Naming something that does not exist yet is how a feature is asked for.
    // Only a call — a claim that something is there — is checked.
    const startPath = await createRepo({
      "src/main/java/com/acme/InvoiceService.java":
        "package com.acme;\npublic class InvoiceService { public void addInvoice() {} }\n"
    });

    const report = await new GroundingService().verify(
      "Add an invoice approval workflow with a configurable approver threshold.",
      { startPath }
    );

    expect(report.unverified).toEqual([]);
  });

  it("confirms a request about something that is there", async () => {
    const startPath = await createRepo({
      "src/main/java/com/acme/InvoiceService.java":
        "package com.acme;\npublic class InvoiceService { public void addInvoice() {} }\n"
    });

    const report = await new GroundingService().verify(
      "Change addInvoice() so it validates the owner first.",
      { startPath }
    );

    expect(report.unverified).toEqual([]);
    expect(report.verified.map((result) => result.claim.symbol)).toContain(
      "addInvoice"
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

/** A workspace of registered repos, as Setup Repo's multi-repo mode builds one. */
async function createWorkspace(
  repos: Record<string, Record<string, string>>
): Promise<string> {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "copilot-ground-ws-"));

  for (const [repoName, files] of Object.entries(repos)) {
    for (const [relativePath, contents] of Object.entries(files)) {
      const fullPath = path.join(workspaceRoot, repoName, relativePath);
      await mkdir(path.dirname(fullPath), { recursive: true });
      await writeFile(fullPath, contents, "utf8");
    }
  }

  await mkdir(path.join(workspaceRoot, ".copilot-architect"), { recursive: true });
  await writeFile(
    path.join(workspaceRoot, ".copilot-architect", "workspace.json"),
    JSON.stringify({
      repos: Object.keys(repos).map((name) => ({ name, path: name }))
    }),
    "utf8"
  );

  return workspaceRoot;
}

async function createRepo(files: Record<string, string>): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-ground-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }

  return repoRoot;
}
