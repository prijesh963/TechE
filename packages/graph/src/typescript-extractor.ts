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
  // under-reporting relevant calls entirely. The same trade applies to
  // `localTypes`: a name bound in a nested closure is folded into the same
  // flat map as the enclosing function's own locals.
  //
  // A call receiver is usually a local variable or a field, not a type —
  // `repo.save(...)` only reaches OrderRepository.save once `repo` is known
  // to be an OrderRepository. `localTypes` (parameters plus declared/
  // constructed local variables) and `fieldTypes` (the enclosing class's own
  // fields, reached through `this.`) resolve the receiver to its declared
  // type before the reference is queued, so the existing identifier
  // resolution below treats it exactly like a direct reference to that type.
  const visitCallsWithin = (
    bodyNode: ts.Node | undefined,
    fromId: string,
    localTypes: Map<string, string>,
    fieldTypes: Map<string, string> | undefined
  ): void => {
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
        } else if (ts.isPropertyAccessExpression(callee)) {
          propertyName = ts.isIdentifier(callee.name) ? callee.name.text : undefined;
          const receiver = callee.expression;

          if (ts.isIdentifier(receiver)) {
            const receiverName = receiver.text;
            identifierName =
              localTypes.get(receiverName) ??
              fieldTypes?.get(receiverName) ??
              receiverName;
          } else if (
            ts.isPropertyAccessExpression(receiver) &&
            receiver.expression.kind === ts.SyntaxKind.ThisKeyword &&
            ts.isIdentifier(receiver.name)
          ) {
            const fieldName = receiver.name.text;
            identifierName = fieldTypes?.get(fieldName) ?? fieldName;
          }
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
    const { types: fieldTypes, arrayElementTypes: fieldArrayElementTypes } =
      collectFieldTypes(classNode);

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
        visitCallsWithin(
          member.body,
          methodId,
          localTypesFor(member.parameters, member.body, fieldArrayElementTypes),
          fieldTypes
        );
      } else if (ts.isConstructorDeclaration(member)) {
        const methodId = addNode(
          "method",
          "constructor",
          member,
          classExported,
          classId
        );
        visitCallsWithin(
          member.body,
          methodId,
          localTypesFor(member.parameters, member.body, fieldArrayElementTypes),
          fieldTypes
        );
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
        visitCallsWithin(
          declaration.initializer.body,
          functionId,
          localTypesFor(
            declaration.initializer.parameters,
            declaration.initializer.body
          ),
          undefined
        );
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
      visitCallsWithin(
        node.body,
        functionId,
        localTypesFor(node.parameters, node.body),
        undefined
      );
      return;
    }

    if (ts.isVariableStatement(node)) {
      visitVariableStatement(node);
      return;
    }

    if (ts.isExpressionStatement(node)) {
      visitCallsWithin(node, fileNodeId, new Map(), undefined);
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

/** The root identifier of a type reference (`Repository` from `Repository<Order>`,
 *  the rightmost segment of a qualified name). Union and other non-reference
 *  type shapes are intentionally left unhandled — the same best-effort scope
 *  as the rest of this extractor. Array shapes are handled separately by
 *  `arrayElementTypeName`, since a receiver typed `Repository[]` is not
 *  itself a `Repository` — only what a `for...of` over it yields is. */
function typeReferenceName(typeNode: ts.TypeNode): string | undefined {
  if (!ts.isTypeReferenceNode(typeNode)) {
    return undefined;
  }
  const typeName = typeNode.typeName;
  if (ts.isIdentifier(typeName)) {
    return typeName.text;
  }
  if (ts.isQualifiedName(typeName) && ts.isIdentifier(typeName.right)) {
    return typeName.right.text;
  }
  return undefined;
}

/** The element type of an array-shaped type node: `Repository` from either
 *  `Repository[]` or `Array<Repository>`. Checked before `typeReferenceName`
 *  everywhere it matters — `Array<Repository>` is itself a `TypeReferenceNode`
 *  named "Array", so `typeReferenceName` alone would report the binding's
 *  type as the literal word "Array" rather than reaching this. */
function arrayElementTypeName(typeNode: ts.TypeNode): string | undefined {
  if (ts.isArrayTypeNode(typeNode)) {
    return typeReferenceName(typeNode.elementType);
  }
  if (
    ts.isTypeReferenceNode(typeNode) &&
    ts.isIdentifier(typeNode.typeName) &&
    typeNode.typeName.text === "Array" &&
    typeNode.typeArguments?.[0]
  ) {
    return typeReferenceName(typeNode.typeArguments[0]);
  }
  return undefined;
}

/** Classifies a type node as either a usable receiver type or an array's
 *  element type, never both — the array check always runs first, for the
 *  reason `arrayElementTypeName` documents. */
function classifyType(typeNode: ts.TypeNode): {
  type?: string;
  elementType?: string;
} {
  const elementType = arrayElementTypeName(typeNode);
  if (elementType) {
    return { elementType };
  }
  return { type: typeReferenceName(typeNode) };
}

interface CollectedTypes {
  types: Map<string, string>;
  /** Element type of an array-typed binding — not itself a usable receiver
   *  type, but what a `for...of` loop over that binding resolves its own
   *  loop variable to. */
  arrayElementTypes: Map<string, string>;
}

function collectParamTypes(
  parameters: ts.NodeArray<ts.ParameterDeclaration>
): CollectedTypes {
  const types = new Map<string, string>();
  const arrayElementTypes = new Map<string, string>();

  for (const param of parameters) {
    if (!ts.isIdentifier(param.name) || !param.type) {
      continue;
    }
    const { type, elementType } = classifyType(param.type);
    if (type) {
      types.set(param.name.text, type);
    } else if (elementType) {
      arrayElementTypes.set(param.name.text, elementType);
    }
  }

  return { types, arrayElementTypes };
}

/**
 * Local variable declarations anywhere inside a function/method body — an
 * explicit type annotation (`const repo: OrderRepository = ...`) or, failing
 * that, a `new` expression's constructor name (`const repo = new
 * OrderRepositoryImpl()`) — plus a `for...of` loop's own variable, resolved
 * to the element type of whatever it iterates (a param, a field reached via
 * `this.`, or another local array declared earlier in the same body).
 * `knownArrayElementTypes` carries the param/field array types in scope
 * before this body is even scanned, so a `for...of` over one of those
 * resolves too. Walks the whole body rather than respecting nested
 * block/closure boundaries, the same over-attribution trade `visitCallsWithin`
 * already makes.
 */
function collectLocalVariableTypes(
  bodyNode: ts.Node | undefined,
  knownArrayElementTypes: Map<string, string>
): Map<string, string> {
  const types = new Map<string, string>();
  if (!bodyNode) {
    return types;
  }

  const localArrayElementTypes = new Map<string, string>();
  const forOfNodes: ts.ForOfStatement[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const classified = node.type ? classifyType(node.type) : undefined;
      const inferred =
        !classified?.type &&
        !classified?.elementType &&
        node.initializer &&
        ts.isNewExpression(node.initializer) &&
        ts.isIdentifier(node.initializer.expression)
          ? node.initializer.expression.text
          : undefined;
      const type = classified?.type ?? inferred;

      if (type) {
        types.set(node.name.text, type);
      } else if (classified?.elementType) {
        localArrayElementTypes.set(node.name.text, classified.elementType);
      }
    } else if (ts.isForOfStatement(node)) {
      forOfNodes.push(node);
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(bodyNode, visit);

  const arrayElementTypes = new Map([
    ...knownArrayElementTypes,
    ...localArrayElementTypes
  ]);

  for (const forOf of forOfNodes) {
    if (
      !ts.isVariableDeclarationList(forOf.initializer) ||
      forOf.initializer.declarations.length !== 1
    ) {
      continue;
    }
    const loopVar = forOf.initializer.declarations[0].name;
    if (!ts.isIdentifier(loopVar) || types.has(loopVar.text)) {
      continue;
    }

    const iterated = forOf.expression;
    let sourceName: string | undefined;
    if (ts.isIdentifier(iterated)) {
      sourceName = iterated.text;
    } else if (
      ts.isPropertyAccessExpression(iterated) &&
      iterated.expression.kind === ts.SyntaxKind.ThisKeyword &&
      ts.isIdentifier(iterated.name)
    ) {
      sourceName = iterated.name.text;
    }

    const elementType = sourceName ? arrayElementTypes.get(sourceName) : undefined;
    if (elementType) {
      types.set(loopVar.text, elementType);
    }
  }

  return types;
}

function localTypesFor(
  parameters: ts.NodeArray<ts.ParameterDeclaration>,
  bodyNode: ts.Node | undefined,
  fieldArrayElementTypes?: Map<string, string>
): Map<string, string> {
  const params = collectParamTypes(parameters);
  const knownArrayElementTypes = new Map([
    ...(fieldArrayElementTypes ?? []),
    ...params.arrayElementTypes
  ]);

  return new Map([
    ...params.types,
    ...collectLocalVariableTypes(bodyNode, knownArrayElementTypes)
  ]);
}

const PROPERTY_MODIFIER_KINDS = new Set([
  ts.SyntaxKind.PrivateKeyword,
  ts.SyntaxKind.PublicKeyword,
  ts.SyntaxKind.ProtectedKeyword,
  ts.SyntaxKind.ReadonlyKeyword
]);

/**
 * Field name -> declared type, for a class's own property declarations and
 * constructor parameter properties (`constructor(private repo:
 * OrderRepository)`), the TS shorthand for declaring and assigning a field in
 * one place. Mirrors the Java extractor's `findFieldTypes`: a call receiver
 * reached through `this.` is usually a field, not a type. `arrayElementTypes`
 * covers an array-typed field (`private repos: OrderRepository[]`) the same
 * way — not a usable receiver type on its own, but what `for (const r of
 * this.repos)` resolves `r` to.
 */
function collectFieldTypes(classNode: ts.ClassDeclaration): CollectedTypes {
  const types = new Map<string, string>();
  const arrayElementTypes = new Map<string, string>();

  const record = (name: string, typeNode: ts.TypeNode): void => {
    const { type, elementType } = classifyType(typeNode);
    if (type) {
      types.set(name, type);
    } else if (elementType) {
      arrayElementTypes.set(name, elementType);
    }
  };

  for (const member of classNode.members) {
    if (
      ts.isPropertyDeclaration(member) &&
      ts.isIdentifier(member.name) &&
      member.type
    ) {
      record(member.name.text, member.type);
      continue;
    }

    if (!ts.isConstructorDeclaration(member)) {
      continue;
    }

    for (const param of member.parameters) {
      if (!ts.isIdentifier(param.name) || !param.type) {
        continue;
      }
      const isParameterProperty =
        ts.canHaveModifiers(param) &&
        ts
          .getModifiers(param)
          ?.some((modifier) => PROPERTY_MODIFIER_KINDS.has(modifier.kind));
      if (!isParameterProperty) {
        continue;
      }
      record(param.name.text, param.type);
    }
  }

  return { types, arrayElementTypes };
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
