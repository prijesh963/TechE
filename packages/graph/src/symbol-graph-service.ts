import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  CURRENT_SCHEMA_VERSION,
  createTrustMetadata,
  findRepoRoot,
  getArtifactFilePath,
  isBinaryPath,
  scanRepository,
  writeJsonFile,
  type DiagnosticMessage
} from "@copilot-architect/shared";

import type {
  SymbolEdge,
  SymbolGraph,
  SymbolGraphOptions,
  SymbolGraphResult,
  SymbolNode
} from "./models.js";
import {
  extractFileSymbols,
  SUPPORTED_EXTENSIONS,
  type PendingReference
} from "./typescript-extractor.js";

const MAX_FILE_BYTES = 256_000;

export class SymbolGraphService {
  /**
   * Builds the repo's symbol/dependency graph and writes it to
   * `.copilot-architect/graph.json`. Real AST extraction for TS/JS files
   * (see typescript-extractor.ts); every other file — including a TS/JS
   * file that fails to parse — still gets a file-level node, so a parse
   * failure on one file never fails the whole build.
   */
  async build(options: SymbolGraphOptions = {}): Promise<SymbolGraphResult> {
    const startPath = path.resolve(options.startPath ?? process.cwd());
    const repoRoot = options.strictRoot ? startPath : await findRepoRoot(startPath);
    const entries = await scanRepository(repoRoot);
    const knownFiles = new Set(entries.map((entry) => entry.relativePath));

    const nodes: SymbolNode[] = [];
    const diagnostics: DiagnosticMessage[] = [];
    const localSymbolsByFile = new Map<string, Map<string, string>>();
    const importSpecifiersByFile = new Map<string, Map<string, string>>();
    const pendingByFile: Array<{ filePath: string; refs: PendingReference[] }> = [];
    const edges: SymbolEdge[] = [];
    const edgeKeys = new Set<string>();

    const addEdge = (edge: SymbolEdge): void => {
      const key = `${edge.kind}|${edge.from}|${edge.to}`;
      if (edgeKeys.has(key)) {
        return;
      }
      edgeKeys.add(key);
      edges.push(edge);
    };

    for (const entry of entries) {
      nodes.push({
        id: entry.relativePath,
        kind: "file",
        name: path.posix.basename(entry.relativePath),
        filePath: entry.relativePath,
        exported: false
      });

      if (
        entry.sizeBytes > MAX_FILE_BYTES ||
        isBinaryPath(entry.relativePath) ||
        !SUPPORTED_EXTENSIONS.has(path.posix.extname(entry.relativePath))
      ) {
        continue;
      }

      let sourceText: string;
      try {
        sourceText = await readFile(entry.absolutePath, "utf8");
      } catch {
        continue;
      }

      const extraction = extractFileSymbols(entry.relativePath, sourceText);
      if (!extraction) {
        diagnostics.push({
          severity: "warning",
          code: "GRAPH_PARSE_FAILED",
          message: `Could not parse ${entry.relativePath} for the symbol graph.`,
          filePath: entry.relativePath
        });
        continue;
      }

      nodes.push(...extraction.nodes);

      const topLevelSymbols = new Map<string, string>();
      for (const node of extraction.nodes) {
        if (node.kind !== "method") {
          topLevelSymbols.set(node.name, node.id);
        }
      }
      localSymbolsByFile.set(entry.relativePath, topLevelSymbols);
      importSpecifiersByFile.set(entry.relativePath, extraction.importSpecifiers);
      pendingByFile.push({
        filePath: entry.relativePath,
        refs: extraction.pendingReferences
      });

      for (const specifier of extraction.importedSpecifiers) {
        const target = resolveImportSpecifier(
          entry.relativePath,
          specifier,
          knownFiles
        );
        if (target) {
          addEdge({ kind: "imports", from: entry.relativePath, to: target });
        }
      }
    }

    const nodesById = new Map(nodes.map((node) => [node.id, node]));

    for (const { filePath, refs } of pendingByFile) {
      const localSymbols = localSymbolsByFile.get(filePath) ?? new Map();
      const importSpecifiers = importSpecifiersByFile.get(filePath) ?? new Map();

      for (const ref of refs) {
        const resolved = resolveIdentifier(
          ref.identifierName,
          filePath,
          localSymbols,
          importSpecifiers,
          localSymbolsByFile,
          knownFiles
        );
        if (!resolved) {
          continue;
        }

        let targetId = resolved;
        if (ref.kind === "calls" && ref.propertyName) {
          const candidateNode = nodesById.get(resolved);
          if (candidateNode?.kind === "class") {
            const methodId = `${resolved}.${ref.propertyName}`;
            if (nodesById.has(methodId)) {
              targetId = methodId;
            }
          }
        }

        if (targetId === ref.fromId) {
          continue;
        }

        addEdge({ kind: ref.kind, from: ref.fromId, to: targetId });
      }
    }

    const graph: SymbolGraph = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      trust: createTrustMetadata({
        artifactKind: "symbol-graph",
        source: "SymbolGraphService"
      }),
      repoRoot,
      nodes,
      edges,
      diagnostics
    };

    const jsonPath = getArtifactFilePath(repoRoot, "graph");
    await writeJsonFile(jsonPath, graph);

    return { repoRoot, graph, jsonPath };
  }
}

const RESOLVABLE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".d.ts"];

/**
 * Resolves a relative import specifier to a known in-repo file path.
 * External package specifiers (anything not starting with ".") are
 * intentionally left unresolved — they are not part of this repo's symbol
 * graph.
 *
 * Handles the common TS/ESM pattern of importing a `.js` specifier that
 * actually resolves to a `.ts` source file (`moduleResolution: NodeNext`):
 * a specifier ending in a known extension is tried as-is first, then with
 * that extension stripped and each candidate extension tried in turn — not
 * just specifiers with no extension at all.
 */
function resolveImportSpecifier(
  fromFilePath: string,
  specifier: string,
  knownFiles: Set<string>
): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }

  const baseDir = path.posix.dirname(fromFilePath);
  const resolvedBase = path.posix.normalize(path.posix.join(baseDir, specifier));
  const existingExtension = RESOLVABLE_EXTENSIONS.find((extension) =>
    resolvedBase.endsWith(extension)
  );
  const withoutExtension = existingExtension
    ? resolvedBase.slice(0, resolvedBase.length - existingExtension.length)
    : resolvedBase;

  const candidates = [
    resolvedBase,
    ...RESOLVABLE_EXTENSIONS.map((extension) => `${withoutExtension}${extension}`),
    ...RESOLVABLE_EXTENSIONS.map((extension) =>
      path.posix.join(withoutExtension, `index${extension}`)
    )
  ];

  return candidates.find((candidate) => knownFiles.has(candidate));
}

/**
 * Resolves an identifier referenced in `filePath` (a heritage clause type or
 * a call-site callee) to a node id: first against symbols declared in the
 * same file, then against an imported binding of the same name — resolving
 * to the specific symbol in the target file when one exists by that name,
 * otherwise to the target file node itself. Returns undefined for anything
 * that resolves to neither (a global/builtin, or an external package).
 */
function resolveIdentifier(
  name: string,
  filePath: string,
  localSymbols: Map<string, string>,
  importSpecifiers: Map<string, string>,
  localSymbolsByFile: Map<string, Map<string, string>>,
  knownFiles: Set<string>
): string | undefined {
  const local = localSymbols.get(name);
  if (local) {
    return local;
  }

  const specifier = importSpecifiers.get(name);
  if (!specifier) {
    return undefined;
  }

  const targetFile = resolveImportSpecifier(filePath, specifier, knownFiles);
  if (!targetFile) {
    return undefined;
  }

  return localSymbolsByFile.get(targetFile)?.get(name) ?? targetFile;
}
