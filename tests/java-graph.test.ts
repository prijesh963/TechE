import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  SymbolGraphService,
  extractJavaFileSymbols,
  type SymbolEdge
} from "../packages/graph/src/index.js";

describe("extractJavaFileSymbols", () => {
  it("extracts package, imports, types, heritage and methods", () => {
    const extraction = extractJavaFileSymbols(
      "src/main/java/com/acme/orders/OrderService.java",
      [
        "package com.acme.orders;",
        "import com.acme.common.BaseService;",
        "import com.acme.common.*;",
        "public class OrderService extends BaseService implements Runnable {",
        "  public void placeOrder(String id) { }",
        "  public void run() { }",
        "}"
      ].join("\n")
    );

    expect(extraction?.packageName).toBe("com.acme.orders");
    expect(extraction?.importedSpecifiers).toEqual([
      "com.acme.common.BaseService",
      "com.acme.common.*"
    ]);
    // The simple name is what heritage and receivers are written as.
    expect(extraction?.importSpecifiers.get("BaseService")).toBe(
      "com.acme.common.BaseService"
    );
    expect(extraction?.qualifiedTypes).toEqual([
      {
        qualifiedName: "com.acme.orders.OrderService",
        nodeId: "src/main/java/com/acme/orders/OrderService.java#OrderService"
      }
    ]);
    expect(extraction?.nodes.map((node) => `${node.kind}:${node.name}`)).toEqual([
      "class:OrderService",
      "method:placeOrder",
      "method:run"
    ]);
    expect(extraction?.pendingReferences.filter((ref) => ref.kind !== "calls")).toEqual(
      [
        expect.objectContaining({ kind: "extends", identifierName: "BaseService" }),
        expect.objectContaining({ kind: "implements", identifierName: "Runnable" })
      ]
    );
  });

  it("is not fooled by braces and quotes inside comments and string literals", () => {
    const extraction = extractJavaFileSymbols(
      "src/main/java/Tricky.java",
      [
        "public class Tricky {",
        '  // a comment with { an unbalanced brace and a "quote',
        "  /* block } comment */",
        "  public void run() {",
        '    String s = "text with } brace and ( paren";',
        "  }",
        "}"
      ].join("\n")
    );

    // The class body closed where the real code closes it, so `run` is found
    // and nothing spurious is picked up out of the comment or the literal.
    expect(extraction?.nodes.map((node) => `${node.kind}:${node.name}`)).toEqual([
      "class:Tricky",
      "method:run"
    ]);
  });

  it("does not mistake a field initializer for a method declaration", () => {
    const extraction = extractJavaFileSymbols(
      "src/main/java/Holder.java",
      [
        "public class Holder {",
        "  private final Repo repo = new Repo();",
        "  public void use() { }",
        "}"
      ].join("\n")
    );

    expect(extraction?.nodes.map((node) => node.name)).toEqual(["Holder", "use"]);
  });

  it("strips generic arguments from heritage so the raw type resolves", () => {
    const extraction = extractJavaFileSymbols(
      "src/main/java/OrderRepository.java",
      "public interface OrderRepository extends JpaRepository<Order, Long> { }"
    );

    expect(extraction?.nodes[0]).toMatchObject({
      kind: "interface",
      name: "OrderRepository"
    });
    expect(extraction?.pendingReferences).toEqual([
      expect.objectContaining({ kind: "extends", identifierName: "JpaRepository" })
    ]);
  });

  it("returns undefined for a non-Java file", () => {
    expect(extractJavaFileSymbols("src/app.ts", "export const a = 1;")).toBeUndefined();
  });
});

describe("SymbolGraphService (Java)", () => {
  it("resolves imports by qualified name and calls through fields and inheritance", async () => {
    const repoRoot = await createJavaRepo({
      "src/main/java/com/acme/common/BaseService.java": [
        "package com.acme.common;",
        "public abstract class BaseService {",
        "  public void audit(String action) { }",
        "}"
      ].join("\n"),
      "src/main/java/com/acme/orders/OrderRepository.java": [
        "package com.acme.orders;",
        "public class OrderRepository {",
        "  public void save(String order) { }",
        "}"
      ].join("\n"),
      "src/main/java/com/acme/orders/OrderService.java": [
        "package com.acme.orders;",
        "import com.acme.common.BaseService;",
        "public class OrderService extends BaseService {",
        "  private final OrderRepository repo = new OrderRepository();",
        "  public void placeOrder(String order) {",
        "    repo.save(order);",
        '    audit("placed");',
        "  }",
        "}"
      ].join("\n")
    });

    const { graph } = await new SymbolGraphService().build({
      startPath: repoRoot,
      strictRoot: true
    });
    const has = (kind: SymbolEdge["kind"], from: string, to: string): boolean =>
      graph.edges.some(
        (edge) => edge.kind === kind && edge.from.endsWith(from) && edge.to.endsWith(to)
      );

    // Java imports resolve by package + type name, not by relative path.
    expect(has("imports", "OrderService.java", "BaseService.java")).toBe(true);
    expect(
      has("extends", "OrderService.java#OrderService", "BaseService.java#BaseService")
    ).toBe(true);
    // `repo` is a field, so the receiver must be mapped to its declared type
    // before the call can reach OrderRepository.save.
    expect(
      has(
        "calls",
        "OrderService.placeOrder",
        "OrderRepository.java#OrderRepository.save"
      )
    ).toBe(true);
    // `audit` is declared on the supertype, not on OrderService.
    expect(
      has("calls", "OrderService.placeOrder", "BaseService.java#BaseService.audit")
    ).toBe(true);
    expect(graph.diagnostics).toEqual([]);
  });

  it("drops a call it cannot resolve rather than pointing it at the class", async () => {
    const repoRoot = await createJavaRepo({
      "src/main/java/com/acme/Widget.java": [
        "package com.acme;",
        "public class Widget {",
        "  public void run() {",
        '    System.out.println("hi");',
        "    unknownHelper();",
        "  }",
        "}"
      ].join("\n")
    });

    const { graph } = await new SymbolGraphService().build({
      startPath: repoRoot,
      strictRoot: true
    });

    // A JDK or unknown call must not produce a vague method -> own-class edge.
    expect(graph.edges.filter((edge) => edge.kind === "calls")).toEqual([]);
  });

  it("still builds a graph when Java and TypeScript sit in one repo", async () => {
    const repoRoot = await createJavaRepo({
      "src/main/java/com/acme/Api.java": [
        "package com.acme;",
        "public class Api { public void handle() { } }"
      ].join("\n"),
      "web/src/client.ts": "export class Client { call() { return 1; } }"
    });

    const { graph } = await new SymbolGraphService().build({
      startPath: repoRoot,
      strictRoot: true
    });
    const classNames = graph.nodes
      .filter((node) => node.kind === "class")
      .map((node) => node.name)
      .sort();

    expect(classNames).toEqual(["Api", "Client"]);
  });
});

async function createJavaRepo(files: Record<string, string>): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-java-graph-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }

  return repoRoot;
}
