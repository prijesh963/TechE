import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  CURRENT_SCHEMA_VERSION,
  createTrustMetadata,
  findRepoRoot,
  getArtifactFilePath,
  isBinaryPath,
  resolveRegisteredRepos,
  scanRepository,
  writeJsonFile,
  type DiagnosticMessage,
  type ScannedEntry
} from "@copilot-architect/shared";

import type {
  SymbolEdge,
  SymbolGraph,
  WorkspaceGraphState,
  SymbolGraphOptions,
  SymbolGraphResult,
  SymbolNode
} from "./models.js";
import { extractJavaFileSymbols, JAVA_EXTENSIONS } from "./java-extractor.js";
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
    const { entries, repos } = await scanGraphEntries(repoRoot);
    const knownFiles = new Set(entries.map((entry) => entry.relativePath));

    const nodes: SymbolNode[] = [];
    const diagnostics: DiagnosticMessage[] = [];
    const localSymbolsByFile = new Map<string, Map<string, string>>();
    const importSpecifiersByFile = new Map<string, Map<string, string>>();
    const pendingByFile: Array<{ filePath: string; refs: PendingReference[] }> = [];
    /** Java qualified type name -> where it is declared. Built across all files. */
    const javaTypeIndex = new Map<string, { nodeId: string; filePath: string }>();
    const javaFiles = new Map<
      string,
      { packageName?: string; importedSpecifiers: string[] }
    >();
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

      const extension = path.posix.extname(entry.relativePath);
      const isJava = JAVA_EXTENSIONS.has(extension);

      if (
        entry.sizeBytes > MAX_FILE_BYTES ||
        isBinaryPath(entry.relativePath) ||
        !(SUPPORTED_EXTENSIONS.has(extension) || isJava)
      ) {
        continue;
      }

      let sourceText: string;
      try {
        sourceText = await readFile(entry.absolutePath, "utf8");
      } catch {
        continue;
      }

      const extraction = isJava
        ? extractJavaFileSymbols(entry.relativePath, sourceText)
        : extractFileSymbols(entry.relativePath, sourceText);
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

      if (isJava) {
        // Java resolves by fully-qualified name, so imports cannot be resolved
        // until every file's package and declared types are known. Defer to
        // the second pass below.
        javaFiles.set(entry.relativePath, {
          packageName: extraction.packageName,
          importedSpecifiers: extraction.importedSpecifiers
        });
        for (const declared of extraction.qualifiedTypes ?? []) {
          javaTypeIndex.set(declared.qualifiedName, {
            nodeId: declared.nodeId,
            filePath: entry.relativePath
          });
        }
        continue;
      }

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

    // Java pass 2: now that every package and type is known, resolve imports by
    // qualified name. A wildcard import (`com.acme.*`) links to every file in
    // that package.
    for (const [filePath, java] of javaFiles) {
      for (const specifier of java.importedSpecifiers) {
        if (specifier.endsWith(".*")) {
          const packagePrefix = specifier.slice(0, -1);
          for (const [qualifiedName, target] of javaTypeIndex) {
            if (
              qualifiedName.startsWith(packagePrefix) &&
              !qualifiedName.slice(packagePrefix.length).includes(".") &&
              target.filePath !== filePath
            ) {
              addEdge({ kind: "imports", from: filePath, to: target.filePath });
            }
          }
          continue;
        }

        const target = javaTypeIndex.get(specifier);
        if (target && target.filePath !== filePath) {
          addEdge({ kind: "imports", from: filePath, to: target.filePath });
        }
      }
    }

    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    /** Type node id -> its resolved supertypes, so inherited calls can be found. */
    const superTypes = new Map<string, string[]>();

    // Two passes: heritage first, so that when calls are resolved the
    // supertype chain is already known and an inherited method can be found.
    for (const pass of ["heritage", "calls"] as const) {
      for (const { filePath, refs } of pendingByFile) {
        const localSymbols = localSymbolsByFile.get(filePath) ?? new Map();
        const importSpecifiers = importSpecifiersByFile.get(filePath) ?? new Map();
        const java = javaFiles.get(filePath);

        for (const ref of refs) {
          const isCall = ref.kind === "calls";
          if (pass === "heritage" ? isCall : !isCall) {
            continue;
          }
          const resolved = java
            ? resolveJavaIdentifier(
                ref.identifierName,
                localSymbols,
                importSpecifiers,
                java.packageName,
                javaTypeIndex
              )
            : resolveIdentifier(
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
            if (
              candidateNode?.kind === "class" ||
              candidateNode?.kind === "interface"
            ) {
              const methodId = findMethodOnTypeOrSupertype(
                resolved,
                ref.propertyName,
                nodesById,
                superTypes
              );
              if (methodId) {
                targetId = methodId;
              } else if (java) {
                // A Java bare call that resolves to no known method is usually a
                // JDK or third-party method. Pointing the edge at the enclosing
                // class instead would be noise, so drop it.
                continue;
              }
            }
          }

          if (targetId === ref.fromId) {
            continue;
          }

          if (ref.kind === "extends" || ref.kind === "implements") {
            superTypes.set(ref.fromId, [
              ...(superTypes.get(ref.fromId) ?? []),
              targetId
            ]);
          }

          addEdge({ kind: ref.kind, from: ref.fromId, to: targetId });
        }
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
      repos,
      nodes,
      edges,
      diagnostics
    };

    const jsonPath = getArtifactFilePath(repoRoot, "graph");
    await writeJsonFile(jsonPath, graph);

    if (repos) {
      // Record what this build learned, so a workspace whose repos share no
      // code can stop paying for a workspace-wide graph on every setup. Kept
      // as its own small file: deciding whether to rebuild must not mean
      // reading a graph that can run to tens of megabytes.
      await writeJsonFile(getArtifactFilePath(repoRoot, "graphWorkspace"), {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        generatedAt: graph.generatedAt,
        repos,
        crossRepoEdgeCount: countCrossRepoEdges(edges)
      } satisfies WorkspaceGraphState);
    }

    return { repoRoot, graph, jsonPath };
  }
}

/**
 * The files to build the graph over: the repo's own when this is a plain repo,
 * or every registered repo's when `repoRoot` is a workspace root. Scanning the
 * root alone reached repos nested inside it but silently missed any registered
 * elsewhere (`../billing-service`), so those repos had no graph at all.
 *
 * Merged paths are prefixed with the repo NAME rather than their location on
 * disk, which keeps ids stable and readable wherever a repo is checked out.
 * One flat namespace is also what makes cross-repo edges resolve: Java's
 * qualified-type index spans every repo, so a service calling
 * `com.acme.OrderService` links to wherever that class is actually declared,
 * and a relative TS specifier still resolves because both sides shift equally.
 */
async function scanGraphEntries(
  repoRoot: string
): Promise<{ entries: ScannedEntry[]; repos?: string[] }> {
  const registered = await resolveRegisteredRepos(repoRoot);

  if (registered.length === 0) {
    return { entries: await scanRepository(repoRoot) };
  }

  const entries: ScannedEntry[] = [];
  const seen = new Set<string>();

  for (const repo of registered) {
    // One unreadable repo must not fail the whole graph.
    const scanned = await scanRepository(repo.repoRoot).catch(() => []);

    for (const entry of scanned) {
      if (seen.has(entry.absolutePath)) continue;
      seen.add(entry.absolutePath);
      entries.push({
        ...entry,
        relativePath: path.posix.join(repo.name, entry.relativePath)
      });
    }
  }

  return { entries, repos: registered.map((repo) => repo.name) };
}

/**
 * Edges whose two ends live in different repos. Zero means the repos share no
 * code, which is the fact worth remembering: nothing downstream can gain from
 * a workspace-wide graph in that case.
 */
function countCrossRepoEdges(edges: SymbolEdge[]): number {
  let count = 0;

  for (const edge of edges) {
    const from = edge.from.slice(0, edge.from.indexOf("/"));
    const to = edge.to.slice(0, edge.to.indexOf("/"));
    if (from && to && from !== to) count += 1;
  }

  return count;
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
/**
 * Finds `typeId.methodName`, walking up resolved supertypes when the type does
 * not declare it itself. Without this an inherited call (`audit(...)` defined
 * on a base class) would resolve to nothing useful.
 */
function findMethodOnTypeOrSupertype(
  typeId: string,
  methodName: string,
  nodesById: Map<string, SymbolNode>,
  superTypes: Map<string, string[]>,
  seen = new Set<string>()
): string | undefined {
  if (seen.has(typeId)) {
    return undefined;
  }
  seen.add(typeId);

  const direct = `${typeId}.${methodName}`;
  if (nodesById.has(direct)) {
    return direct;
  }

  for (const superTypeId of superTypes.get(typeId) ?? []) {
    const inherited = findMethodOnTypeOrSupertype(
      superTypeId,
      methodName,
      nodesById,
      superTypes,
      seen
    );
    if (inherited) {
      return inherited;
    }
  }

  return undefined;
}

/**
 * Java name resolution, in the order the language itself uses: a type declared
 * in this file wins, then an explicit single-type import, then another type in
 * the same package. Anything unresolved (a JDK type, a third-party class, a
 * local variable used as a call receiver) is dropped rather than guessed —
 * same precision-over-recall stance as the TS path.
 */
function resolveJavaIdentifier(
  identifierName: string,
  localSymbols: Map<string, string>,
  importSpecifiers: Map<string, string>,
  packageName: string | undefined,
  javaTypeIndex: Map<string, { nodeId: string; filePath: string }>
): string | undefined {
  const local = localSymbols.get(identifierName);
  if (local) {
    return local;
  }

  const imported = importSpecifiers.get(identifierName);
  if (imported) {
    return javaTypeIndex.get(imported)?.nodeId;
  }

  if (packageName) {
    return javaTypeIndex.get(`${packageName}.${identifierName}`)?.nodeId;
  }

  return undefined;
}

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
