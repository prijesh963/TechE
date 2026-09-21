import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";
import {
  SymbolGraphService,
  extractFileSymbols,
  type SymbolNode
} from "../packages/graph/src/index.js";
import { getArtifactFilePath } from "../packages/shared/src/index.js";

describe("extractFileSymbols", () => {
  it("extracts classes, methods, heritage, and functions with line numbers", () => {
    const extraction = extractFileSymbols(
      "src/payment-service.ts",
      [
        "export class PaymentService extends BaseService implements Auditable {",
        "  process() {",
        "    return true;",
        "  }",
        "}",
        "",
        "export function retry() {",
        "  return true;",
        "}",
        "",
        "export const audit = () => true;"
      ].join("\n")
    );

    expect(extraction).toBeDefined();
    const byId = new Map(extraction?.nodes.map((node) => [node.id, node]));

    expect(byId.get("src/payment-service.ts#PaymentService")).toMatchObject({
      kind: "class",
      name: "PaymentService",
      exported: true,
      startLine: 1
    });
    expect(byId.get("src/payment-service.ts#PaymentService.process")).toMatchObject({
      kind: "method",
      name: "process"
    });
    expect(byId.get("src/payment-service.ts#retry")).toMatchObject({
      kind: "function",
      exported: true
    });
    expect(byId.get("src/payment-service.ts#audit")).toMatchObject({
      kind: "function",
      exported: true
    });

    expect(extraction?.pendingReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "extends", identifierName: "BaseService" }),
        expect.objectContaining({ kind: "implements", identifierName: "Auditable" })
      ])
    );
  });

  it("returns undefined for an unsupported extension", () => {
    expect(extractFileSymbols("README.md", "# hello")).toBeUndefined();
  });

  it("degrades gracefully on unparseable input instead of throwing", () => {
    // Malformed but not fatal — the TS parser is resilient by design, so this
    // mainly documents that a bad file never throws out of extractFileSymbols.
    expect(() =>
      extractFileSymbols("src/broken.ts", "class {{{ ??? export")
    ).not.toThrow();
  });
});

describe("SymbolGraphService", () => {
  it("builds file, class, and function nodes and writes graph.json", async () => {
    const repoRoot = await createRepo({
      "src/invoices/invoice-service.ts": [
        "export function approveInvoice() {",
        "  return true;",
        "}"
      ].join("\n"),
      "src/server.ts": [
        "import { approveInvoice } from './invoices/invoice-service.js';",
        "",
        "export function approve() {",
        "  return approveInvoice();",
        "}"
      ].join("\n"),
      "README.md": "# fixture"
    });

    const result = await new SymbolGraphService().build({
      startPath: repoRoot,
      strictRoot: true
    });

    expect(existsSync(getArtifactFilePath(repoRoot, "graph"))).toBe(true);
    expect(result.graph.repoRoot).toBe(repoRoot);

    const nodeIds = result.graph.nodes.map((node: SymbolNode) => node.id);
    expect(nodeIds).toEqual(
      expect.arrayContaining([
        "README.md",
        "src/server.ts",
        "src/invoices/invoice-service.ts",
        "src/invoices/invoice-service.ts#approveInvoice",
        "src/server.ts#approve"
      ])
    );

    // Cross-file "imports" edge, file -> file.
    expect(result.graph.edges).toEqual(
      expect.arrayContaining([
        {
          kind: "imports",
          from: "src/server.ts",
          to: "src/invoices/invoice-service.ts"
        }
      ])
    );

    // Cross-file "calls" edge resolved through the import binding to the
    // specific function symbol, not just the file.
    expect(result.graph.edges).toEqual(
      expect.arrayContaining([
        {
          kind: "calls",
          from: "src/server.ts#approve",
          to: "src/invoices/invoice-service.ts#approveInvoice"
        }
      ])
    );
  });

  it("resolves a property-access call to the specific method when the class is known", async () => {
    const repoRoot = await createRepo({
      "src/payment-service.ts": [
        "export class PaymentService {",
        "  process() {",
        "    return true;",
        "  }",
        "}"
      ].join("\n"),
      "src/controller.ts": [
        "import { PaymentService } from './payment-service.js';",
        "",
        "export function handle() {",
        "  return PaymentService.process();",
        "}"
      ].join("\n")
    });

    const result = await new SymbolGraphService().build({
      startPath: repoRoot,
      strictRoot: true
    });

    expect(result.graph.edges).toEqual(
      expect.arrayContaining([
        {
          kind: "calls",
          from: "src/controller.ts#handle",
          to: "src/payment-service.ts#PaymentService.process"
        }
      ])
    );
  });

  it("resolves class inheritance across files to the base class symbol", async () => {
    const repoRoot = await createRepo({
      "src/base-service.ts": "export class BaseService {}",
      "src/payment-service.ts": [
        "import { BaseService } from './base-service.js';",
        "",
        "export class PaymentService extends BaseService {}"
      ].join("\n")
    });

    const result = await new SymbolGraphService().build({
      startPath: repoRoot,
      strictRoot: true
    });

    expect(result.graph.edges).toEqual(
      expect.arrayContaining([
        {
          kind: "extends",
          from: "src/payment-service.ts#PaymentService",
          to: "src/base-service.ts#BaseService"
        }
      ])
    );
  });

  it("does not resolve an import to an external package", async () => {
    const repoRoot = await createRepo({
      "src/server.ts": [
        "import express from 'express';",
        "",
        "export function start() {",
        "  return express();",
        "}"
      ].join("\n")
    });

    const result = await new SymbolGraphService().build({
      startPath: repoRoot,
      strictRoot: true
    });

    expect(
      result.graph.edges.some(
        (edge) => edge.kind === "imports" && edge.to === "express"
      )
    ).toBe(false);
  });

  it("resolves a call through a field reached via this.", async () => {
    const repoRoot = await createRepo({
      "src/payment-service.ts": [
        "export class PaymentService {",
        "  process() {",
        "    return true;",
        "  }",
        "}"
      ].join("\n"),
      "src/controller.ts": [
        "import { PaymentService } from './payment-service.js';",
        "",
        "export class Controller {",
        "  private service: PaymentService = new PaymentService();",
        "  handle() {",
        "    return this.service.process();",
        "  }",
        "}"
      ].join("\n")
    });

    const result = await new SymbolGraphService().build({
      startPath: repoRoot,
      strictRoot: true
    });

    expect(result.graph.edges).toEqual(
      expect.arrayContaining([
        {
          kind: "calls",
          from: "src/controller.ts#Controller.handle",
          to: "src/payment-service.ts#PaymentService.process"
        }
      ])
    );
  });

  it("resolves a call through a constructor parameter property", async () => {
    const repoRoot = await createRepo({
      "src/payment-service.ts": [
        "export class PaymentService {",
        "  process() {",
        "    return true;",
        "  }",
        "}"
      ].join("\n"),
      "src/controller.ts": [
        "import { PaymentService } from './payment-service.js';",
        "",
        "export class Controller {",
        "  constructor(private service: PaymentService) {}",
        "  handle() {",
        "    return this.service.process();",
        "  }",
        "}"
      ].join("\n")
    });

    const result = await new SymbolGraphService().build({
      startPath: repoRoot,
      strictRoot: true
    });

    expect(result.graph.edges).toEqual(
      expect.arrayContaining([
        {
          kind: "calls",
          from: "src/controller.ts#Controller.handle",
          to: "src/payment-service.ts#PaymentService.process"
        }
      ])
    );
  });

  it("resolves a call through a local variable's explicit type annotation", async () => {
    const repoRoot = await createRepo({
      "src/payment-service.ts": [
        "export class PaymentService {",
        "  process() {",
        "    return true;",
        "  }",
        "}"
      ].join("\n"),
      "src/controller.ts": [
        "import { PaymentService } from './payment-service.js';",
        "declare function getService(): PaymentService;",
        "",
        "export function handle() {",
        "  const service: PaymentService = getService();",
        "  return service.process();",
        "}"
      ].join("\n")
    });

    const result = await new SymbolGraphService().build({
      startPath: repoRoot,
      strictRoot: true
    });

    expect(result.graph.edges).toEqual(
      expect.arrayContaining([
        {
          kind: "calls",
          from: "src/controller.ts#handle",
          to: "src/payment-service.ts#PaymentService.process"
        }
      ])
    );
  });

  it("resolves a call through a local variable's inferred `new` type", async () => {
    const repoRoot = await createRepo({
      "src/payment-service.ts": [
        "export class PaymentService {",
        "  process() {",
        "    return true;",
        "  }",
        "}"
      ].join("\n"),
      "src/controller.ts": [
        "import { PaymentService } from './payment-service.js';",
        "",
        "export function handle() {",
        "  const service = new PaymentService();",
        "  return service.process();",
        "}"
      ].join("\n")
    });

    const result = await new SymbolGraphService().build({
      startPath: repoRoot,
      strictRoot: true
    });

    expect(result.graph.edges).toEqual(
      expect.arrayContaining([
        {
          kind: "calls",
          from: "src/controller.ts#handle",
          to: "src/payment-service.ts#PaymentService.process"
        }
      ])
    );
  });

  it("resolves a call through a plain method parameter's type", async () => {
    const repoRoot = await createRepo({
      "src/payment-service.ts": [
        "export class PaymentService {",
        "  process() {",
        "    return true;",
        "  }",
        "}"
      ].join("\n"),
      "src/controller.ts": [
        "import { PaymentService } from './payment-service.js';",
        "",
        "export class Controller {",
        "  handle(service: PaymentService) {",
        "    return service.process();",
        "  }",
        "}"
      ].join("\n")
    });

    const result = await new SymbolGraphService().build({
      startPath: repoRoot,
      strictRoot: true
    });

    expect(result.graph.edges).toEqual(
      expect.arrayContaining([
        {
          kind: "calls",
          from: "src/controller.ts#Controller.handle",
          to: "src/payment-service.ts#PaymentService.process"
        }
      ])
    );
  });

  it("prefers a local variable's type over a same-named field's", async () => {
    const repoRoot = await createRepo({
      "src/payment-service.ts": [
        "export class PaymentService {",
        "  process() {",
        "    return 'field-type';",
        "  }",
        "}"
      ].join("\n"),
      "src/other-service.ts": [
        "export class OtherService {",
        "  process() {",
        "    return 'local-type';",
        "  }",
        "}"
      ].join("\n"),
      "src/controller.ts": [
        "import { PaymentService } from './payment-service.js';",
        "import { OtherService } from './other-service.js';",
        "",
        "export class Controller {",
        "  private service: PaymentService = new PaymentService();",
        "  handle() {",
        "    const service = new OtherService();",
        "    return service.process();",
        "  }",
        "}"
      ].join("\n")
    });

    const result = await new SymbolGraphService().build({
      startPath: repoRoot,
      strictRoot: true
    });

    expect(result.graph.edges).toContainEqual({
      kind: "calls",
      from: "src/controller.ts#Controller.handle",
      to: "src/other-service.ts#OtherService.process"
    });
    expect(result.graph.edges).not.toContainEqual({
      kind: "calls",
      from: "src/controller.ts#Controller.handle",
      to: "src/payment-service.ts#PaymentService.process"
    });
  });

  it("emits a file-level node for non-TS/JS files without failing the build", async () => {
    const repoRoot = await createRepo({
      "src/service.py": "def approve():\n    return True\n",
      "src/util.ts": "export const helper = () => true;"
    });

    const result = await new SymbolGraphService().build({
      startPath: repoRoot,
      strictRoot: true
    });

    expect(result.graph.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "src/service.py", kind: "file" })
      ])
    );
    expect(result.graph.diagnostics).toEqual([]);
  });
});

describe("graph CLI", () => {
  it("supports CLI graph and --json output", async () => {
    const repoRoot = await createRepo({
      "src/invoice-service.ts":
        "export function approveInvoice() { return 'approved invoice'; }"
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const textResult = await runCli(["graph", "--path", repoRoot], {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message)
    });

    const jsonStdout: string[] = [];
    const jsonResult = await runCli(["graph", "--path", repoRoot, "--json"], {
      stdout: (message) => jsonStdout.push(message),
      stderr: (message) => stderr.push(message)
    });
    const graph = JSON.parse(jsonStdout.join("\n"));

    expect(textResult.exitCode).toBe(0);
    expect(jsonResult.exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toContain("Nodes:");
    expect(
      graph.nodes.some(
        (node: { id: string }) => node.id === "src/invoice-service.ts#approveInvoice"
      )
    ).toBe(true);
    expect(existsSync(getArtifactFilePath(repoRoot, "graph"))).toBe(true);
  });
});

async function createRepo(files: Record<string, string>): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-graph-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }

  return repoRoot;
}
