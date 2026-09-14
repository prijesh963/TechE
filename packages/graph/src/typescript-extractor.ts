import path from "node:path";

import ts from "typescript";

import type { SymbolEdgeKind, SymbolNode, SymbolNodeKind } from "./models.js";

export const SUPPORTED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);

export interface PendingReference {
  kind: Extract<SymbolEdgeKind, "extends" | "implements" | "calls">;
  fromId: string;
  identifierName: string;
  /** For a `calls` reference via property access (`service.process()`), the accessed member name. */
  propertyName?: string;
}

export interface FileExtraction {
  filePath: string;
  fileNodeId: string;
  nodes: SymbolNode[];
  /** Local binding name -> raw import specifier, as written in the source. */
  importSpecifiers: Map<string, string>;
  /** Every raw import specifier referenced in the file, deduped. */
  importedSpecifiers: string[];
  pendingReferences: PendingReference[];
  /**
   * Java only. Imports and heritage resolve by fully-qualified name rather
   * than by relative path, so the service needs the declaring package and the
   * qualified names this file declares to build a global type index.
   */
  packageName?: string;
  qualifiedTypes?: { qualifiedName: string; nodeId: string }[];
}

/**
 * Extracts a structural summary of one TS/JS file using the real
 * TypeScript AST — not regex heuristics. Deliberately scoped to what a
 * single file's syntax can tell us without a type checker: imports,
 * top-level class/function/interface declarations (including
 * `export const x = () => {}`), class members, heritage clauses, and
 * best-effort call-site identifiers. Cross-file resolution (turning an
 * import specifier or a called identifier into an actual node id) happens
 * one level up, in SymbolGraphService, once every file has been parsed.
 *
 * Returns undefined when the extension isn't supported or the file fails
 * to parse — callers should fall back to a file-level node rather than
 * fail the whole graph build over one file.
 */
export function extractFileSymbols(
  filePath: string,
  sourceText: string
): FileExtraction | undefined {
  if (!SUPPORTED_EXTENSIONS.has(path.posix.extname(filePath))) {
    return undefined;
  }

  let sourceFile: ts.SourceFile;
  try {
    sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      scriptKindFor(filePath)
    );
  } catch {
    return undefined;
  }

  const nodes: SymbolNode[] = [];
  const importSpecifiers = new Map<string, string>();
  const importedSpecifiers = new Set<string>();
  const pendingReferences: PendingReference[] = [];
  const fileNodeId = filePath;

  const lineOf = (pos: number): number =>
    sourceFile.getLineAndCharacterOfPosition(pos).line + 1;

  const isExported = (node: ts.Node): boolean => {
    if (!ts.canHaveModifiers(node)) {
      return false;
    }
    const modifiers = ts.getModifiers(node);
    return Boolean(
      modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    );
  };

  const rootIdentifierName = (expression: ts.Expression): string | undefined =>
    ts.isIdentifier(expression) ? expression.text : undefined;

  const addNode = (
    kind: SymbolNodeKind,
    name: string,
    node: ts.Node,
    exported: boolean,
    ownerId?: string
  ): string => {
    const id = ownerId ? `${ownerId}.${name}` : `${filePath}#${name}`;
    nodes.push({
      id,
      kind,
      name,
      filePath,
      startLine: lineOf(node.getStart(sourceFile)),
      endLine: lineOf(node.getEnd()),
      exported
    });
    return id;
  };

  const visitHeritage = (
    clauses: ts.NodeArray<ts.HeritageClause> | undefined,
    fromId: string
  ): void => {
    for (const clause of clauses ?? []) {
      const kind =
        clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
      for (const type of clause.types) {
        const identifierName = rootIdentifierName(type.expression);
        if (identifierName) {
          pendingReferences.push({ kind, fromId, identifierName });
        }
      }
    }
  };

  // Scoping caveat: this attributes every call found anywhere inside
  // `bodyNode` — including inside a nested function expression — to
  // `fromId`. Precise nested-scope attribution would need a symbol table;
  // over-attributing is an acceptable trade for a first pass over
  // under-reporting relevant calls entirely.
  const visitCallsWithin = (bodyNode: ts.Node | undefined, fromId: string): void => {
    if (!bodyNode) {
      return;
    }

    const visitCall = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        let identifierName: string | undefined;
        let propertyName: string | undefined;

        if (ts.isIdentifier(callee)) {
          identifierName = callee.text;
        } else if (
          ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression)
        ) {
          identifierName = callee.expression.text;
          propertyName = ts.isIdentifier(callee.name) ? callee.name.text : undefined;
        }

        if (identifierName) {
          pendingReferences.push({
            kind: "calls",
            fromId,
            identifierName,
            propertyName
          });
        }
      }
      ts.forEachChild(node, visitCall);
    };

    ts.forEachChild(bodyNode, visitCall);
  };

  const visitClassMembers = (classNode: ts.ClassDeclaration, classId: string): void => {
    const classExported = isExported(classNode);
    for (const member of classNode.members) {
      if (
        ts.isMethodDeclaration(member) &&
        member.name &&
        ts.isIdentifier(member.name)
      ) {
        const methodId = addNode(
          "method",
          member.name.text,
          member,
          classExported,
          classId
        );
        visitCallsWithin(member.body, methodId);
      } else if (ts.isConstructorDeclaration(member)) {
        const methodId = addNode(
          "method",
          "constructor",
          member,
          classExported,
          classId
        );
        visitCallsWithin(member.body, methodId);
      }
    }
  };

  const visitImport = (node: ts.ImportDeclaration): void => {
    if (!ts.isStringLiteral(node.moduleSpecifier)) {
      return;
    }

    const specifier = node.moduleSpecifier.text;
    importedSpecifiers.add(specifier);
    const clause = node.importClause;
    if (!clause) {
      return;
    }

    if (clause.name) {
      importSpecifiers.set(clause.name.text, specifier);
    }
    if (clause.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        importSpecifiers.set(clause.namedBindings.name.text, specifier);
      } else if (ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          importSpecifiers.set(element.name.text, specifier);
        }
      }
    }
  };

  const visitVariableStatement = (node: ts.VariableStatement): void => {
    const exported = isExported(node);
    for (const declaration of node.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer &&
        (ts.isArrowFunction(declaration.initializer) ||
          ts.isFunctionExpression(declaration.initializer))
      ) {
        const functionId = addNode(
          "function",
          declaration.name.text,
          declaration,
          exported
        );
        visitCallsWithin(declaration.initializer.body, functionId);
      }
    }
  };

  const visitTopLevel = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      visitImport(node);
      return;
    }

    if (ts.isClassDeclaration(node) && node.name) {
      const classId = addNode("class", node.name.text, node, isExported(node));
      visitHeritage(node.heritageClauses, classId);
      visitClassMembers(node, classId);
      return;
    }

    if (ts.isInterfaceDeclaration(node)) {
      const interfaceId = addNode("interface", node.name.text, node, isExported(node));
      visitHeritage(node.heritageClauses, interfaceId);
      return;
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      const functionId = addNode("function", node.name.text, node, isExported(node));
      visitCallsWithin(node.body, functionId);
      return;
    }

    if (ts.isVariableStatement(node)) {
      visitVariableStatement(node);
      return;
    }

    if (ts.isExpressionStatement(node)) {
      visitCallsWithin(node, fileNodeId);
    }
  };

  try {
    for (const statement of sourceFile.statements) {
      visitTopLevel(statement);
    }
  } catch {
    return undefined;
  }

  return {
    filePath,
    fileNodeId,
    nodes,
    importSpecifiers,
    importedSpecifiers: [...importedSpecifiers],
    pendingReferences
  };
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  if (filePath.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }
  if (filePath.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }
  if (filePath.endsWith(".js")) {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
}
