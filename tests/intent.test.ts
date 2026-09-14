import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  classifyIntent,
  extractEntities,
  QueryIntentService
} from "../packages/intent/src/index.js";
import { runCli } from "../packages/cli/src/index.js";

describe("classifyIntent", () => {
  it("classifies debugging queries", () => {
    expect(classifyIntent("Why is customer creation failing?")).toBe("debugging");
    expect(classifyIntent("The login page is broken")).toBe("debugging");
  });

  it("classifies refactor queries", () => {
    expect(classifyIntent("Refactor the invoice approval workflow")).toBe("refactor");
  });

  it("classifies test queries", () => {
    expect(classifyIntent("Add coverage for the payment specs")).toBe("test");
  });

  it("classifies feature queries", () => {
    expect(classifyIntent("Implement a new export feature")).toBe("feature");
  });

  it("falls back to unknown when nothing matches", () => {
    expect(classifyIntent("Payment gateway options overview")).toBe("unknown");
  });

  it("prefers debugging when a query matches multiple categories", () => {
    expect(classifyIntent("Why is this broken, should I refactor it?")).toBe(
      "debugging"
    );
  });
});

describe("extractEntities", () => {
  it("drops stopwords and intent-trigger words, dedupes, preserves order", () => {
    expect(extractEntities("Why is customer creation failing?")).toEqual([
      "customer",
      "creation"
    ]);
  });

  it("drops short words and caps at maxEntities", () => {
    expect(extractEntities("a an to of in on at by go up it is my hi", 8)).toEqual([]);
    expect(
      extractEntities("alpha beta gamma delta epsilon zeta eta theta iota", 3)
    ).toEqual(["alpha", "beta", "gamma"]);
  });
});

describe("QueryIntentService", () => {
  it("classifies intent and resolves likely components/tests for a debugging query", async () => {
    const repoRoot = await createRepo({
      "src/customer/CustomerController.ts":
        "import { CustomerService } from './CustomerService';\n" +
        "export class CustomerController {\n" +
        "  private service = new CustomerService();\n" +
        "  createCustomer() { return this.service.createCustomer(); }\n" +
        "}\n",
      "src/customer/CustomerService.ts":
        "import { CustomerValidator } from './CustomerValidator';\n" +
        "export class CustomerService {\n" +
        "  private validator = new CustomerValidator();\n" +
        "  createCustomer() { return this.validator.validate(); }\n" +
        "}\n",
      "src/customer/CustomerValidator.ts":
        "export class CustomerValidator {\n" +
        "  validate() { return true; }\n" +
        "}\n",
      "tests/customer/CustomerController.test.ts":
        "test('creates a customer', () => {})",
      "tests/customer/CustomerService.test.ts": "test('creates a customer', () => {})",
      "tests/customer/CustomerValidator.test.ts":
        "test('validates a customer', () => {})",
      "src/unrelated/reporting.ts": "export function generateReport() { return []; }"
    });

    const result = await new QueryIntentService().analyze({
      startPath: repoRoot,
      query: "Why is customer creation failing?"
    });

    expect(result.intent).toBe("debugging");
    expect(result.entities).toEqual(["customer", "creation"]);
    expect(result.refinedQuery).toBe("customer creation");

    const componentPaths = result.likelyComponents.map((item) => item.filePath);
    expect(componentPaths).toEqual(
      expect.arrayContaining([
        "src/customer/CustomerController.ts",
        "src/customer/CustomerService.ts"
      ])
    );

    const testPaths = result.relevantTests.map((item) => item.filePath);
    expect(testPaths).toEqual(
      expect.arrayContaining([
        "tests/customer/CustomerController.test.ts",
        "tests/customer/CustomerService.test.ts"
      ])
    );

    for (const item of result.likelyComponents) {
      expect(item.reason.length).toBeGreaterThan(0);
    }
  });

  it("throws on an empty query", async () => {
    const repoRoot = await createRepo({ "README.md": "# empty" });

    await expect(
      new QueryIntentService().analyze({ startPath: repoRoot, query: "   " })
    ).rejects.toThrow("query is required");
  });

  it("supports the CLI intent command with --json", async () => {
    const repoRoot = await createRepo({
      "src/payment/PaymentGateway.ts":
        "export class PaymentGateway { charge() { return true; } }",
      "tests/payment/PaymentGateway.test.ts": "test('charges', () => {})"
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const result = await runCli(
      ["intent", "Refactor the payment gateway", "--json", "--path", repoRoot],
      {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message)
      }
    );

    expect(result.exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const parsed = JSON.parse(stdout.join("\n"));
    expect(parsed.intent).toBe("refactor");
    expect(parsed.entities).toContain("payment");
  });

  it("prints a human-readable summary without --json", async () => {
    const repoRoot = await createRepo({
      "src/payment/PaymentGateway.ts":
        "export class PaymentGateway { charge() { return true; } }"
    });
    const stdout: string[] = [];

    const result = await runCli(["intent", "Refactor payment", "--path", repoRoot], {
      stdout: (message) => stdout.push(message),
      stderr: () => undefined
    });

    expect(result.exitCode).toBe(0);
    const text = stdout.join("\n");
    expect(text).toContain("Copilot Architect: intent");
    expect(text).toContain("Intent: refactor");
    expect(text).toContain("Likely components");
  });
});

async function createRepo(files: Record<string, string>): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-architect-intent-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }

  return repoRoot;
}
