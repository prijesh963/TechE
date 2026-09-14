import path from "node:path";

import type { SymbolNode } from "./models.js";
import type { FileExtraction, PendingReference } from "./typescript-extractor.js";

export const JAVA_EXTENSIONS = new Set([".java"]);

/**
 * A focused Java *declaration* scanner, not a full Java parser.
 *
 * The TS/JS path uses the real TypeScript AST because `typescript` is already
 * a dependency. The only viable pure-JS Java parser (java-parser) pins
 * chevrotain 11, which drags in a high-severity lodash advisory, and forcing a
 * newer chevrotain breaks it — so a parser would have cost this repo its
 * zero-vulnerability state. What the graph actually needs from Java is
 * declaration-level: package, imports, type declarations with their heritage,
 * method declarations, and call sites. Those are regular enough to scan
 * reliably once comments and string literals are blanked out, which is what
 * `blankNonCode` below does.
 *
 * Deliberate limits, consistent with the "best effort, degrade gracefully"
 * contract the TS extractor already has: annotations are ignored rather than
 * modelled, anonymous and local classes are not given their own nodes, and a
 * call is attributed to the enclosing method by position. On anything it
 * cannot make sense of it returns fewer nodes rather than wrong ones.
 */
export function extractJavaFileSymbols(
  filePath: string,
  sourceText: string
): FileExtraction | undefined {
  if (!JAVA_EXTENSIONS.has(path.posix.extname(filePath))) {
    return undefined;
  }

  const code = blankNonCode(sourceText);
  const nodes: SymbolNode[] = [];
  const pendingReferences: PendingReference[] = [];
  const importSpecifiers = new Map<string, string>();
  const importedSpecifiers: string[] = [];
  const qualifiedTypes: { qualifiedName: string; nodeId: string }[] = [];

  const packageName = code.match(/\bpackage\s+([\w.]+)\s*;/)?.[1];

  for (const match of code.matchAll(
    /\bimport\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/g
  )) {
    const specifier = match[1];
    if (importedSpecifiers.includes(specifier)) continue;
    importedSpecifiers.push(specifier);

    // `import a.b.C;` binds the simple name C. A wildcard import binds nothing
    // resolvable by name, so it is recorded for the file-level `imports` edge
    // only.
    const simpleName = specifier.split(".").pop();
    if (simpleName && simpleName !== "*") {
      importSpecifiers.set(simpleName, specifier);
    }
  }

  for (const type of findTypeDeclarations(code)) {
    const nodeId = `${filePath}#${type.name}`;
    nodes.push({
      id: nodeId,
      kind: type.keyword === "interface" ? "interface" : "class",
      name: type.name,
      filePath,
      startLine: lineAt(code, type.declarationIndex),
      endLine: lineAt(code, type.bodyEnd),
      exported: type.isPublic
    });

    qualifiedTypes.push({
      qualifiedName: packageName ? `${packageName}.${type.name}` : type.name,
      nodeId
    });

    for (const superName of type.extends) {
      pendingReferences.push({
        kind: "extends",
        fromId: nodeId,
        identifierName: superName
      });
    }
    for (const interfaceName of type.implements) {
      pendingReferences.push({
        kind: "implements",
        fromId: nodeId,
        identifierName: interfaceName
      });
    }

    // A Java call receiver is usually a field, not a type — `repo.save(...)`
    // only reaches OrderRepository.save once `repo` is known to be an
    // OrderRepository. Without this the service→repository edges, the most
    // useful ones for citations, would never resolve.
    const fieldTypes = findFieldTypes(code, type);

    for (const method of findMethodDeclarations(code, type)) {
      const methodId = `${nodeId}.${method.name}`;
      nodes.push({
        id: methodId,
        kind: "method",
        name: method.name,
        filePath,
        startLine: lineAt(code, method.nameIndex),
        endLine: lineAt(code, method.bodyEnd),
        exported: method.isPublic
      });

      for (const call of findCalls(code, method.bodyStart, method.bodyEnd)) {
        if (call.receiver) {
          // Map a field receiver to its declared type; a receiver that is
          // already a type name (a static call) passes through unchanged.
          const receiverType = fieldTypes.get(call.receiver) ?? call.receiver;
          pendingReferences.push({
            kind: "calls",
            fromId: methodId,
            identifierName: receiverType,
            propertyName: call.method
          });
          continue;
        }

        // A bare `helper(...)` is a call on this same type.
        pendingReferences.push({
          kind: "calls",
          fromId: methodId,
          identifierName: type.name,
          propertyName: call.method
        });
      }
    }
  }

  return {
    filePath,
    fileNodeId: filePath,
    nodes,
    importSpecifiers,
    importedSpecifiers,
    pendingReferences,
    packageName,
    qualifiedTypes
  };
}

/**
 * Replaces comments and string/char literal contents with spaces, preserving
 * every offset so line numbers and index arithmetic stay correct. Scanning
 * declarations without this is what makes naive regex approaches wrong — a
 * `//` in a URL string or a `{` inside a comment throws off brace matching.
 */
function blankNonCode(source: string): string {
  const out = source.split("");
  let index = 0;

  const blankTo = (end: number): void => {
    for (let i = index; i < end && i < out.length; i += 1) {
      if (out[i] !== "\n") out[i] = " ";
    }
    index = end;
  };

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      blankTo(end === -1 ? source.length : end);
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      blankTo(end === -1 ? source.length : end + 2);
      continue;
    }
    if (char === '"' && source.startsWith('"""', index)) {
      const end = source.indexOf('"""', index + 3);
      blankTo(end === -1 ? source.length : end + 3);
      continue;
    }
    if (char === '"' || char === "'") {
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (source[cursor] === char || source[cursor] === "\n") break;
        cursor += 1;
      }
      blankTo(Math.min(cursor + 1, source.length));
      continue;
    }
    index += 1;
  }

  return out.join("");
}

interface JavaTypeDeclaration {
  keyword: string;
  name: string;
  isPublic: boolean;
  declarationIndex: number;
  bodyStart: number;
  bodyEnd: number;
  extends: string[];
  implements: string[];
  /** Body ranges of types declared inside this one, so members are not double-counted. */
  nestedBodies: { start: number; end: number }[];
}

function findTypeDeclarations(code: string): JavaTypeDeclaration[] {
  const declarations: JavaTypeDeclaration[] = [];
  const pattern = /\b(class|interface|enum|record)\s+(\w+)/g;

  for (const match of code.matchAll(pattern)) {
    const declarationIndex = match.index ?? 0;
    const bodyStart = code.indexOf("{", declarationIndex);
    if (bodyStart === -1) continue;

    const bodyEnd = matchBrace(code, bodyStart);
    if (bodyEnd === -1) continue;

    // `extends`/`implements` live between the name and the opening brace.
    const header = code.slice(declarationIndex, bodyStart);
    declarations.push({
      keyword: match[1],
      name: match[2],
      isPublic: /\bpublic\b/.test(
        code.slice(Math.max(0, declarationIndex - 60), declarationIndex)
      ),
      declarationIndex,
      bodyStart,
      bodyEnd,
      extends: parseTypeList(header, "extends"),
      implements: parseTypeList(header, "implements"),
      nestedBodies: []
    });
  }

  // Mark nested type bodies on their enclosing declaration.
  for (const outer of declarations) {
    for (const inner of declarations) {
      if (
        inner !== outer &&
        inner.bodyStart > outer.bodyStart &&
        inner.bodyEnd <= outer.bodyEnd
      ) {
        outer.nestedBodies.push({ start: inner.bodyStart, end: inner.bodyEnd });
      }
    }
  }

  return declarations;
}

/** Pulls the type names out of an `extends A` / `implements A, B<C>` clause. */
function parseTypeList(header: string, keyword: string): string[] {
  const match = new RegExp(`\\b${keyword}\\b([^{]*)`).exec(header);
  if (!match) return [];

  // Stop at the next clause keyword, then drop generic arguments so
  // `Repository<Order, Long>` resolves as `Repository`.
  const clause = match[1].split(/\b(?:implements|extends|permits)\b/)[0];
  return clause
    .replace(/<[^<>]*(?:<[^<>]*>)?[^<>]*>/g, "")
    .split(",")
    .map((entry) => entry.trim().split(".").pop() ?? "")
    .filter((entry) => /^[A-Za-z_$][\w$]*$/.test(entry));
}

interface JavaMethodDeclaration {
  name: string;
  isPublic: boolean;
  nameIndex: number;
  bodyStart: number;
  bodyEnd: number;
}

const CONTROL_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "return",
  "new",
  "synchronized",
  "try",
  "do",
  "else",
  "throw",
  "assert",
  "yield"
]);

/**
 * Method declarations are found at the type's own body level. Depth is the
 * discriminator that makes this reliable without a parser: `name(` directly
 * inside a class body is a declaration, while the same shape inside a method
 * body is a call.
 */
function findMethodDeclarations(
  code: string,
  type: JavaTypeDeclaration
): JavaMethodDeclaration[] {
  const methods: JavaMethodDeclaration[] = [];
  const body = code.slice(type.bodyStart + 1, type.bodyEnd);
  const pattern = /(\w+)\s*\(/g;

  for (const match of body.matchAll(pattern)) {
    const nameIndex = type.bodyStart + 1 + (match.index ?? 0);
    const name = match[1];

    if (CONTROL_KEYWORDS.has(name)) continue;
    if (isInsideAny(nameIndex, type.nestedBodies)) continue;
    if (depthBetween(code, type.bodyStart + 1, nameIndex) !== 0) continue;
    // `new Repo()` in a field initializer and `x.y()` are not declarations.
    if (/(?:\bnew\s+|\.\s*)$/.test(code.slice(Math.max(0, nameIndex - 8), nameIndex))) {
      continue;
    }

    const parenStart = code.indexOf("(", nameIndex);
    const parenEnd = matchParen(code, parenStart);
    if (parenEnd === -1) continue;

    // A declaration is followed by its body, or by `;` when abstract or on an
    // interface. Anything else (an annotation argument, a field initializer
    // call) is not a method declaration.
    const after = code.slice(parenEnd + 1, parenEnd + 200);
    const bodyOpen = after.search(/\S/) === -1 ? -1 : parenEnd + 1 + after.search(/\S/);
    const nextChar = bodyOpen === -1 ? "" : code[bodyOpen];
    const isAbstract = /^\s*(?:throws\s+[\w.,\s]+)?;/.test(after);

    if (isAbstract) {
      methods.push({
        name,
        isPublic: isPublicAt(code, nameIndex),
        nameIndex,
        bodyStart: parenEnd,
        bodyEnd: parenEnd
      });
      continue;
    }

    const braceStart =
      nextChar === "{"
        ? bodyOpen
        : /^\s*throws\s/.test(after)
          ? code.indexOf("{", parenEnd)
          : -1;
    if (braceStart === -1) continue;

    const braceEnd = matchBrace(code, braceStart);
    if (braceEnd === -1) continue;

    methods.push({
      name,
      isPublic: isPublicAt(code, nameIndex),
      nameIndex,
      bodyStart: braceStart,
      bodyEnd: braceEnd
    });
  }

  return methods;
}

/**
 * Field name -> declared type, for the type's own body only. Requires the type
 * to start uppercase, which is the Java convention and keeps `int count = 0`
 * and local primitives out of the map.
 */
function findFieldTypes(code: string, type: JavaTypeDeclaration): Map<string, string> {
  const fields = new Map<string, string>();
  const body = code.slice(type.bodyStart + 1, type.bodyEnd);

  for (const match of body.matchAll(/\b([A-Z]\w*)(?:<[^<>]*>)?\s+(\w+)\s*[;=]/g)) {
    const offset = type.bodyStart + 1 + (match.index ?? 0);
    if (isInsideAny(offset, type.nestedBodies)) continue;
    // Fields sit at the type's own body level; anything deeper is a local.
    if (depthBetween(code, type.bodyStart + 1, offset) !== 0) continue;
    if (!fields.has(match[2])) {
      fields.set(match[2], match[1]);
    }
  }

  return fields;
}

function isPublicAt(code: string, index: number): boolean {
  const lineStart = code.lastIndexOf("\n", index);
  return /\bpublic\b/.test(code.slice(Math.max(0, lineStart), index));
}

interface JavaCall {
  receiver?: string;
  method: string;
}

/** Best-effort call sites inside a method body: `helper(...)` or `repo.save(...)`. */
function findCalls(code: string, bodyStart: number, bodyEnd: number): JavaCall[] {
  if (bodyEnd <= bodyStart) return [];

  const body = code.slice(bodyStart, bodyEnd);
  const calls: JavaCall[] = [];
  const seen = new Set<string>();

  for (const match of body.matchAll(/(?:(\w+)\s*\.\s*)?\b(\w+)\s*\(/g)) {
    const [, receiver, method] = match;
    if (CONTROL_KEYWORDS.has(method)) continue;
    if (receiver && CONTROL_KEYWORDS.has(receiver)) continue;

    const key = `${receiver ?? ""}.${method}`;
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push({ receiver, method });
  }

  return calls;
}

function matchBrace(code: string, openIndex: number): number {
  return matchDelimiter(code, openIndex, "{", "}");
}

function matchParen(code: string, openIndex: number): number {
  return matchDelimiter(code, openIndex, "(", ")");
}

function matchDelimiter(
  code: string,
  openIndex: number,
  open: string,
  close: string
): number {
  if (code[openIndex] !== open) return -1;
  let depth = 0;

  for (let index = openIndex; index < code.length; index += 1) {
    if (code[index] === open) depth += 1;
    else if (code[index] === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function depthBetween(code: string, start: number, end: number): number {
  let depth = 0;
  for (let index = start; index < end; index += 1) {
    if (code[index] === "{") depth += 1;
    else if (code[index] === "}") depth -= 1;
  }
  return depth;
}

function isInsideAny(index: number, ranges: { start: number; end: number }[]): boolean {
  return ranges.some((range) => index > range.start && index < range.end);
}

function lineAt(code: string, index: number): number {
  let line = 1;
  for (let cursor = 0; cursor < index && cursor < code.length; cursor += 1) {
    if (code[cursor] === "\n") line += 1;
  }
  return line;
}
