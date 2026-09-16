import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { SymbolGraphService } from "../packages/graph/src/index.js";
import { IndexingService, type LocalIndex } from "../packages/indexer/src/index.js";
import { runCli } from "../packages/cli/src/index.js";
import { getArtifactDirectoryPath } from "../packages/shared/src/index.js";

const execFileAsync = promisify(execFile);

describe("IndexingService", () => {
  it("creates JSON index artifacts with required file metadata", async () => {
    const repoRoot = await createRepo({
      ".git/HEAD": "ref: refs/heads/main",
      "src/invoices/approval.ts":
        "import { Invoice } from './model';\nexport function approveInvoice() { return true; }\n",
      "tests/invoices/approval.test.ts": "test('approval', () => {})",
      "README.md": "# Invoice workflow",
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } })
    });

    const result = await new IndexingService().index({ startPath: repoRoot });
    const document = result.index.documents.find(
      (candidate) => candidate.relativePath === "src/invoices/approval.ts"
    );

    expect(result.mode).toBe("full");
    expect(existsSync(result.indexPath)).toBe(true);
    expect(existsSync(result.statusPath)).toBe(true);
    expect(document).toEqual(
      expect.objectContaining({
        relativePath: "src/invoices/approval.ts",
        extension: ".ts",
        languageGuess: "TypeScript",
        isTestFile: false,
        isConfigFile: false,
        isDocFile: false
      })
    );
    expect(document?.contentHash).toHaveLength(64);
    expect(document?.imports).toContain("./model");
    expect(document?.symbols.map((symbol) => symbol.name)).toContain("approveInvoice");
    expect(result.index.stats.testFileCount).toBe(1);
    expect(result.index.stats.docFileCount).toBe(1);
    expect(result.index.stats.configFileCount).toBe(1);
  });

  it("returns ranked search results", async () => {
    const repoRoot = await createRepo({
      "src/invoiceApproval.ts":
        "export function approveInvoice() { return 'invoice approval'; }",
      "src/customer.ts": "export function customer() { return 'invoice'; }",
      "README.md": "invoice approval overview"
    });
    const service = new IndexingService();

    const indexResult = await service.index({ startPath: repoRoot });
    const response = await service.search({
      startPath: repoRoot,
      query: "invoice approval"
    });

    expect(response.results.length).toBeGreaterThanOrEqual(2);
    expect(response.results[0]?.relativePath).toBe("src/invoiceApproval.ts");
    expect(response.results[0]?.matchedFields).toEqual(
      expect.arrayContaining(["path", "preview", "symbols"])
    );
    // Corpus stats are precomputed at index time, not rebuilt per query.
    expect(indexResult.index.searchStats?.docCount).toBe(3);
    expect(indexResult.index.searchStats?.termDocFreq.invoice).toBeGreaterThan(0);
    // Per-field averages are stored so BM25 normalizes each field independently.
    expect(indexResult.index.searchStats?.avgFieldLengths?.path).toBeGreaterThan(0);
    expect(indexResult.index.searchStats?.avgFieldLengths?.preview).toBeGreaterThan(
      indexResult.index.searchStats?.avgFieldLengths?.path ?? 0
    );
    // Symbol anchor gives file:line precision into the matched declaration.
    expect(response.results[0]?.anchor?.symbol).toBe("approveInvoice");
    expect(response.results[0]?.anchor?.line).toBeGreaterThan(0);
  });

  it("skips ignored folders", async () => {
    const repoRoot = await createRepo({
      "src/app.ts": "export function app() {}",
      "node_modules/pkg/index.js": "export const ignored = true;",
      "dist/bundle.js": "export const ignored = true;",
      ".venv/lib/site-packages/pkg.py": "ignored = True"
    });

    const result = await new IndexingService().index({ startPath: repoRoot });
    const paths = result.index.documents.map((document) => document.relativePath);

    expect(paths).toContain("src/app.ts");
    expect(paths).not.toContain("node_modules/pkg/index.js");
    expect(paths).not.toContain("dist/bundle.js");
    expect(paths).not.toContain(".venv/lib/site-packages/pkg.py");
  });

  it("reuses unchanged documents during incremental indexing", async () => {
    const repoRoot = await createRepo({
      "src/stable.ts": "export function stable() { return true; }",
      "src/change.ts": "export function changeMe() { return 1; }"
    });
    const service = new IndexingService();
    const first = await service.index({ startPath: repoRoot });
    const stableBefore = requireDocument(first.index, "src/stable.ts");
    const changeBefore = requireDocument(first.index, "src/change.ts");

    await writeFile(
      path.join(repoRoot, "src/change.ts"),
      "export function changeMe() { return 2; }",
      "utf8"
    );

    const second = await service.index({ startPath: repoRoot });
    const stableAfter = requireDocument(second.index, "src/stable.ts");
    const changeAfter = requireDocument(second.index, "src/change.ts");

    expect(second.mode).toBe("incremental");
    expect(stableAfter.indexedAt).toBe(stableBefore.indexedAt);
    expect(changeAfter.contentHash).not.toBe(changeBefore.contentHash);
    expect(changeAfter.indexedAt).not.toBe(changeBefore.indexedAt);
  });

  it("supports rebuild, status, similar feature search, and CLI search JSON", async () => {
    const repoRoot = await createRepo({
      "src/features/invoiceApproval.ts":
        "export class InvoiceApprovalWorkflow {}\nexport function approveInvoice() {}",
      "tests/features/invoiceApproval.test.ts": "test('invoice approval', () => {})"
    });
    const service = new IndexingService();
    const rebuilt = await service.index({ startPath: repoRoot, rebuild: true });
    const status = await service.status(repoRoot);
    const similar = await service.findSimilarFeatures({
      startPath: repoRoot,
      query: "invoice approval"
    });
    const stdout: string[] = [];
    const cliResult = await runCli(
      ["search", "invoice approval", "--json", "--path", repoRoot],
      {
        stdout: (message) => stdout.push(message),
        stderr: () => undefined
      }
    );

    expect(rebuilt.mode).toBe("rebuild");
    expect(status.exists).toBe(true);
    expect(status.documentCount).toBe(2);
    expect(similar.results[0]?.relativePath).toBe("src/features/invoiceApproval.ts");
    expect(cliResult.exitCode).toBe(0);
    expect(JSON.parse(stdout.join("\n")).results[0].relativePath).toBe(
      "src/features/invoiceApproval.ts"
    );
  });

  it("supports CLI index --rebuild", async () => {
    const repoRoot = await createRepo({
      "src/index.ts": "export function main() {}"
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const result = await runCli(["index", repoRoot, "--rebuild"], {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message)
    });

    expect(result.exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Mode: rebuild");
    expect(
      existsSync(path.join(getArtifactDirectoryPath(repoRoot, "index"), "index.json"))
    ).toBe(true);
  });

  it("surfaces a graph-connected file with zero keyword overlap", async () => {
    const repoRoot = await createRepo({
      "src/payment-service.ts": [
        "import { RetryUtility } from './retry-utility.js';",
        "",
        "export function processPayment() {",
        "  return RetryUtility.run(() => true);",
        "}"
      ].join("\n"),
      "src/retry-utility.ts": [
        "export class RetryUtility {",
        "  static run(fn: () => boolean) {",
        "    return fn();",
        "  }",
        "}"
      ].join("\n"),
      "src/unrelated.ts":
        "export function unrelated() { return 'nothing to do with payments'; }"
    });
    await new SymbolGraphService().build({ startPath: repoRoot, strictRoot: true });
    const service = new IndexingService();
    await service.index({ startPath: repoRoot });

    const response = await service.search({
      startPath: repoRoot,
      query: "process payment"
    });
    const relativePaths = response.results.map((result) => result.relativePath);
    const retryUtility = response.results.find(
      (result) => result.relativePath === "src/retry-utility.ts"
    );

    // unrelated.ts shares no vocabulary with the query and has no graph
    // connection to it, so it correctly never enters the results at all —
    // the graph signal is what earns retry-utility.ts its spot despite
    // matching no keywords either.
    expect(relativePaths).not.toContain("src/unrelated.ts");
    expect(retryUtility?.matchedFields).toEqual([]);
    expect(retryUtility?.signals).toContain("graph");
  });

  it("does not add a graph signal when no graph has been built", async () => {
    const repoRoot = await createRepo({
      "src/payment-service.ts": [
        "import { RetryUtility } from './retry-utility.js';",
        "export function processPayment() { return RetryUtility.run(() => true); }"
      ].join("\n"),
      "src/retry-utility.ts":
        "export class RetryUtility { static run(fn: () => boolean) { return fn(); } }"
    });
    const service = new IndexingService();
    await service.index({ startPath: repoRoot });

    const response = await service.search({
      startPath: repoRoot,
      query: "process payment"
    });

    expect(response.results.every((result) => !result.signals.includes("graph"))).toBe(
      true
    );
  });

  it("precomputes git activity at index time and surfaces a recency signal", async () => {
    if (!(await gitAvailable())) {
      return;
    }

    const repoRoot = await createRepo({
      "src/hot.ts": "export const hot = 1;",
      "src/cold.ts": "export const cold = 1;"
    });
    await initializeGitRepo(repoRoot);
    await writeFile(path.join(repoRoot, "src/hot.ts"), "export const hot = 2;", "utf8");
    await commitAll(repoRoot, "touch hot");

    const service = new IndexingService();
    const indexResult = await service.index({ startPath: repoRoot });
    const response = await service.search({ startPath: repoRoot, query: "export" });
    const hot = response.results.find((result) => result.relativePath === "src/hot.ts");

    expect(
      indexResult.index.gitActivity?.find(
        (activity) => activity.filePath === "src/hot.ts"
      )?.commitCount
    ).toBe(2);
    expect(hot?.signals).toContain("recency");
  });

  it("reports lexical and structural signals for an ordinary keyword match", async () => {
    const repoRoot = await createRepo({
      "src/invoiceApproval.ts":
        "export function approveInvoice() { return 'invoice approval'; }"
    });
    const service = new IndexingService();
    await service.index({ startPath: repoRoot });

    const response = await service.search({
      startPath: repoRoot,
      query: "invoice approval"
    });

    expect(response.results[0]?.signals).toEqual(
      expect.arrayContaining(["lexical", "structural"])
    );
  });

  it("lists the indexed files so a repo can be enumerated without a query", async () => {
    // Regression: an agent asked to analyze a Java repo guessed English
    // entry-point keywords ("main", "app", "server"), matched nothing, and
    // concluded the repo was empty. Enumeration must not depend on a guess.
    const repoRoot = await createRepo({
      "svc-orders/src/OrderService.java":
        "package com.acme.orders;\npublic class OrderService { public void placeOrder() {} }",
      "svc-billing/src/BillingService.java":
        "package com.acme.billing;\npublic class BillingService { public void invoice() {} }",
      "svc-orders/pom.xml": "<project><artifactId>orders</artifactId></project>",
      "docs/notes.md": "# Notes"
    });
    const service = new IndexingService();

    for (const guess of ["main", "app", "server", "bootstrap"]) {
      const miss = await service.search({ startPath: repoRoot, query: guess });
      expect(miss.results).toEqual([]);
    }

    const inventory = await service.listFiles({ startPath: repoRoot });

    expect(inventory.totalFiles).toBe(4);
    expect(inventory.returnedFiles).toBe(4);
    expect(inventory.languageCounts.Java).toBe(2);
    expect(inventory.directoryCounts["svc-orders"]).toBe(2);
    expect(inventory.files.map((file) => file.relativePath)).toEqual(
      expect.arrayContaining([
        "svc-orders/src/OrderService.java",
        "svc-billing/src/BillingService.java"
      ])
    );
    // Real symbol names are what make the follow-up search actually work.
    const orderService = inventory.files.find((file) =>
      file.relativePath.endsWith("OrderService.java")
    );
    expect(orderService?.symbols).toContain("OrderService");

    const hit = await service.search({ startPath: repoRoot, query: "OrderService" });
    expect(hit.results.length).toBeGreaterThan(0);
  });

  it("filters, caps, and still reports the true total when truncated", async () => {
    const repoRoot = await createRepo({
      "src/a/One.java": "public class One {}",
      "src/a/Two.java": "public class Two {}",
      "src/b/Three.java": "public class Three {}"
    });
    const service = new IndexingService();

    const filtered = await service.listFiles({ startPath: repoRoot, filter: "src/a" });
    expect(filtered.files.map((file) => file.relativePath)).toEqual([
      "src/a/One.java",
      "src/a/Two.java"
    ]);
    // totalFiles stays the repo-wide count so a caller can tell it filtered.
    expect(filtered.totalFiles).toBe(3);

    const capped = await service.listFiles({ startPath: repoRoot, limit: 1 });
    expect(capped.returnedFiles).toBe(1);
    expect(capped.totalFiles).toBe(3);
  });

  it("does not mistake a CamelCase class for a config file", async () => {
    // `SecurityConfig.java` matched a plain "config" substring check, so the one
    // file a security review most needs was demoted in the capped listing and
    // filtered out of findSimilarFeatures entirely.
    const repoRoot = await createRepo({
      "src/main/java/com/acme/SecurityConfig.java": "public class SecurityConfig {}",
      "src/ConfigService.ts": "export class ConfigService {}",
      "vite.config.ts": "export default {};",
      "src/config/app.ts": "export const app = 1;"
    });

    const inventory = await new IndexingService().listFiles({ startPath: repoRoot });
    const isConfig = (relativePath: string): boolean =>
      inventory.files.find((file) => file.relativePath === relativePath)
        ?.isConfigFile ?? false;

    expect(isConfig("src/main/java/com/acme/SecurityConfig.java")).toBe(false);
    expect(isConfig("src/ConfigService.ts")).toBe(false);
    // Genuine config keeps its classification.
    expect(isConfig("vite.config.ts")).toBe(true);
    expect(isConfig("src/config/app.ts")).toBe(true);
  });

  it("surfaces a shared library the query never mentions", async () => {
    // The payoff of a workspace-wide graph: nothing in shared-lib matches a
    // query about placing an order, but OrderService.place calls
    // Thruster.calibrate, and that edge is the only thing that can surface it.
    const parent = await mkdtemp(path.join(tmpdir(), "copilot-xrepo-search-"));
    const write = async (repo: string, files: Record<string, string>) => {
      for (const [relativePath, contents] of Object.entries(files)) {
        const fullPath = path.join(parent, repo, relativePath);
        await mkdir(path.dirname(fullPath), { recursive: true });
        await writeFile(fullPath, contents, "utf8");
      }
    };

    await write("shared-lib", {
      "src/main/java/com/acme/core/Thruster.java":
        "package com.acme.core;\npublic class Thruster {\n" +
        "  public boolean calibrate(String id) { return id != null; }\n}"
    });
    await write("svc-orders", {
      "src/main/java/com/acme/orders/OrderService.java":
        "package com.acme.orders;\nimport com.acme.core.Thruster;\n" +
        "public class OrderService {\n  private Thruster thruster;\n" +
        "  public void placeOrder(String id) { thruster.calibrate(id); }\n}"
    });
    await write("platform", {
      ".copilot-architect/workspace.json": JSON.stringify({
        repos: [
          { name: "shared-lib", path: "../shared-lib" },
          { name: "svc-orders", path: "../svc-orders" }
        ]
      })
    });

    const workspaceRoot = path.join(parent, "platform");
    const service = new IndexingService();
    const search = async () =>
      (await service.search({ startPath: workspaceRoot, query: "placeOrder" })).results;

    // Without a workspace graph the pass is inert — this is exactly how a
    // workspace whose repos share no code behaves, and it must stay that way.
    const before = await search();
    expect(before.map((result) => result.repoName)).toEqual(["svc-orders"]);

    await new SymbolGraphService().build({
      startPath: workspaceRoot,
      strictRoot: true
    });

    const after = await search();
    const shared = after.find((result) => result.repoName === "shared-lib");
    expect(shared?.relativePath).toBe("src/main/java/com/acme/core/Thruster.java");
    // Only the graph found it, and it claims no keyword score it did not earn.
    expect(shared?.signals).toEqual(["graph"]);
    expect(shared?.matchedFields).toEqual([]);
    // The lexical hit is still there and still first.
    expect(after[0]?.repoName).toBe("svc-orders");
  });

  it("answers for every registered repo, not just the workspace root", async () => {
    // Regression: `@architect Analyze repo and explain more about R2D2` returned
    // "the provided context is empty — the only file shown is workspace.json".
    // The workspace root holds registration, not code, so every read path that
    // resolved it alone saw an empty repo while both real repos sat indexed.
    const workspaceRoot = await createRepo({
      ".copilot-architect/workspace.json": JSON.stringify({
        schemaVersion: "0.1.0",
        workspaceName: "acme",
        repos: [
          { name: "svc-orders", path: "svc-orders" },
          { name: "web-ui", path: "web-ui" }
        ]
      }),
      "svc-orders/src/main/java/com/acme/R2D2Service.java":
        "package com.acme;\npublic class R2D2Service { public void astromech() {} }",
      "svc-orders/pom.xml": "<project><artifactId>orders</artifactId></project>",
      "web-ui/src/app/r2d2.component.ts":
        'export class R2d2Component { droid = "R2D2"; }'
    });
    const service = new IndexingService();

    const inventory = await service.listFiles({ startPath: workspaceRoot });

    expect(inventory.totalFiles).toBe(3);
    expect(inventory.repos?.map((repo) => repo.name)).toEqual(["svc-orders", "web-ui"]);
    // Every entry says which repo it came from, and its path stays relative to
    // that repo so a caller can still open it.
    expect(
      inventory.files.map((file) => `${file.repoName}::${file.relativePath}`)
    ).toEqual(
      expect.arrayContaining([
        "svc-orders::src/main/java/com/acme/R2D2Service.java",
        "web-ui::src/app/r2d2.component.ts"
      ])
    );

    const found = await service.search({ startPath: workspaceRoot, query: "R2D2" });
    expect(found.results.map((result) => result.repoName).sort()).toEqual([
      "svc-orders",
      "web-ui"
    ]);
  });

  it("leaves a single repo on the single-repo path", async () => {
    // The fan-out must not change behaviour for a workspace that registers only
    // itself, which is how every ordinary repo is set up.
    const repoRoot = await createRepo({
      ".copilot-architect/workspace.json": JSON.stringify({
        repos: [{ name: "self", path: "." }]
      }),
      "src/app.ts": "export const app = 1;"
    });

    const inventory = await new IndexingService().listFiles({ startPath: repoRoot });

    expect(inventory.repos).toBeUndefined();
    expect(inventory.files.map((file) => file.repoName)).toEqual([undefined]);
    expect(inventory.files.map((file) => file.relativePath)).toContain("src/app.ts");
  });

  it("finds an identifier that carries a digit", async () => {
    // "R2D2Service" tokenized to one opaque "r2d2service", so searching the
    // exact name the user asked about could not reach the file defining it.
    const repoRoot = await createRepo({
      "src/R2D2Service.java": "public class R2D2Service {}",
      "src/Utf8Decoder.java": "public class Utf8Decoder {}"
    });
    const service = new IndexingService();

    const droid = await service.search({ startPath: repoRoot, query: "R2D2" });
    expect(droid.results.map((result) => result.relativePath)).toContain(
      "src/R2D2Service.java"
    );

    const decoder = await service.search({ startPath: repoRoot, query: "utf8" });
    expect(decoder.results.map((result) => result.relativePath)).toContain(
      "src/Utf8Decoder.java"
    );
  });

  it("recognises dependency manifests that have no telling extension", async () => {
    // An auditor filtering the inventory on isConfigFile was blind to whole
    // ecosystems: go.mod, Gemfile and requirements.txt matched none of the
    // extension checks and none of the hardcoded names.
    const repoRoot = await createRepo({
      "requirements.txt": "fastapi==0.110.0",
      "requirements-dev.txt": "pytest==8.0.0",
      "go.mod": "module example.com/svc",
      Gemfile: "source 'https://rubygems.org'",
      "Cargo.toml": "[package]\nname = 'svc'",
      "api/Api.csproj": "<Project Sdk='Microsoft.NET.Sdk' />",
      "svc/build.gradle": "dependencies {}",
      "src/app.py": "def main(): pass"
    });

    const inventory = await new IndexingService().listFiles({ startPath: repoRoot });
    const configPaths = inventory.files
      .filter((file) => file.isConfigFile)
      .map((file) => file.relativePath);

    expect(configPaths).toEqual(
      expect.arrayContaining([
        "requirements.txt",
        "requirements-dev.txt",
        "go.mod",
        "Gemfile",
        "Cargo.toml",
        "api/Api.csproj",
        "svc/build.gradle"
      ])
    );
    // Source is still source — the widening must not swallow the app.
    expect(configPaths).not.toContain("src/app.py");
  });

  it("ranks source files ahead of tests and config when the list is capped", async () => {
    const repoRoot = await createRepo({
      "package.json": "{}",
      "tests/app.test.ts": "test('x', () => {})",
      "src/app.ts": "export const app = 1;"
    });

    const inventory = await new IndexingService().listFiles({
      startPath: repoRoot,
      limit: 1
    });

    // A truncated list must still surface the file that explains the repo.
    expect(inventory.files[0]?.relativePath).toBe("src/app.ts");
  });
});

function requireDocument(index: LocalIndex, relativePath: string) {
  const document = index.documents.find(
    (candidate) => candidate.relativePath === relativePath
  );

  if (!document) {
    throw new Error(`Missing document ${relativePath}`);
  }

  return document;
}

async function createRepo(files: Record<string, string>): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-architect-index-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }

  return repoRoot;
}

async function initializeGitRepo(repoRoot: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await commitAll(repoRoot, "initial");
}

async function commitAll(repoRoot: string, message: string): Promise<void> {
  await execFileAsync("git", ["add", "."], { cwd: repoRoot });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Copilot Architect",
      "-c",
      "user.email=copilot-architect@example.test",
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
