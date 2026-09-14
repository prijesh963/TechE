import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ContextMeasurementService } from "../packages/measurement/src/index.js";
import { runCli } from "../packages/cli/src/index.js";

describe("ContextMeasurementService", () => {
  it("measures naive-whole-repo vs selected-file context for a request", async () => {
    const repoRoot = await createRepo({
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
      "src/invoices/InvoiceApproval.ts":
        "export function approveInvoice() { return 'invoice approval'; }",
      "src/unrelated/reporting.ts":
        "export function generateReport() { return 'quarterly report data here'; }",
      "README.md": "# Invoice workflow"
    });

    const result = await new ContextMeasurementService().measure({
      startPath: repoRoot,
      request: "Add invoice approval workflow"
    });

    expect(result.naiveWholeRepo.fileCount).toBeGreaterThanOrEqual(3);
    expect(result.naiveWholeRepo.totalBytes).toBeGreaterThan(0);
    expect(result.currentToolSelection.relevantFileCount).toBeGreaterThan(0);
    expect(result.currentToolSelection.totalBytes).toBeGreaterThan(0);
    // The naive measurement must include at least as much as the selection —
    // selection is always a subset of the repo's readable source files.
    expect(result.naiveWholeRepo.totalBytes).toBeGreaterThanOrEqual(
      result.currentToolSelection.totalBytes
    );
    expect(result.estimatedTokenReductionPercent).toBeGreaterThanOrEqual(0);
  });

  it("throws on an empty request", async () => {
    const repoRoot = await createRepo({ "README.md": "# empty" });

    await expect(
      new ContextMeasurementService().measure({ startPath: repoRoot, request: "   " })
    ).rejects.toThrow("request is required");
  });

  it("supports the CLI measure command with --json", async () => {
    const repoRoot = await createRepo({
      "src/payment/PaymentGateway.ts":
        "export class PaymentGateway { charge() { return true; } }"
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const result = await runCli(
      ["measure", "Add payment gateway support", "--json", "--path", repoRoot],
      {
        stdout: (message) => stdout.push(message),
        stderr: (message) => stderr.push(message)
      }
    );

    expect(result.exitCode).toBe(0);
    expect(stderr).toEqual([]);
    const parsed = JSON.parse(stdout.join("\n"));
    expect(parsed.request).toBe("Add payment gateway support");
    expect(parsed.naiveWholeRepo.fileCount).toBeGreaterThan(0);
    expect(parsed.currentToolSelection.relevantFileCount).toBeGreaterThan(0);
    expect(typeof parsed.estimatedTokenReductionPercent).toBe("number");
  });

  it("prints a human-readable summary without --json", async () => {
    const repoRoot = await createRepo({
      "src/payment/PaymentGateway.ts":
        "export class PaymentGateway { charge() { return true; } }"
    });
    const stdout: string[] = [];

    const result = await runCli(
      ["measure", "Add payment gateway support", "--path", repoRoot],
      {
        stdout: (message) => stdout.push(message),
        stderr: () => undefined
      }
    );

    expect(result.exitCode).toBe(0);
    const text = stdout.join("\n");
    expect(text).toContain("Copilot Architect: measure");
    expect(text).toContain("Naive whole repo:");
    expect(text).toContain("Estimated token reduction:");
  });
});

async function createRepo(files: Record<string, string>): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-architect-measure-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }

  return repoRoot;
}
