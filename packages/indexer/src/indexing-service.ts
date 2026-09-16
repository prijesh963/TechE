import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  WorkspaceService,
  collectGitActivity,
  type WorkspaceRepoDescriptor
} from "@copilot-architect/core";
import type { SymbolGraph } from "@copilot-architect/graph";
import {
  CURRENT_SCHEMA_VERSION,
  type CodeSymbol,
  type ScannedEntry,
  getArtifactDirectoryPath,
  getArtifactFilePath,
  isBinaryPath,
  readJsonFile,
  resolveRegisteredRepos,
  scanRepository,
  writeJsonFile
} from "@copilot-architect/shared";

import type {
  DocumentTokens,
  IndexedFile,
  IndexOptions,
  IndexResult,
  IndexStats,
  IndexStatus,
  ListFilesOptions,
  LocalIndex,
  RepoFileEntry,
  RepoFileInventory,
  RepoFileInventoryRepo,
  SearchAnchor,
  SearchOptions,
  SearchResponse,
  SearchResult,
  SearchSignal,
  SearchStats,
  SimilarFeatureOptions,
  TokenCounts,
  WorkspaceIndexOptions,
  WorkspaceIndexResult,
  WorkspaceSearchOptions,
  WorkspaceSearchResponse,
  WorkspaceSearchResult
} from "./models.js";

const INDEX_VERSION = "0.1.0-json";
const INDEX_FILE_NAME = "index.json";
const STATUS_FILE_NAME = "status.json";
const DEFAULT_MAX_FILE_BYTES = 512_000;
const PREVIEW_LENGTH = 4_000;
const BM25_K1 = 1.5;
const BM25_B = 0.75;
const RRF_K = 60;
const FIELD_WEIGHTS: Record<string, number> = {
  path: 3,
  symbols: 2,
  preview: 1,
  imports: 0.8
};

export class IndexingService {
  async index(options: IndexOptions = {}): Promise<IndexResult> {
    const startPath = path.resolve(options.startPath ?? process.cwd());
    const repoRoot = await resolveRepoRoot(startPath, options.strictRoot);
    const indexPath = getIndexPath(repoRoot);
    const statusPath = getStatusPath(repoRoot);
    const existingIndex =
      options.rebuild === true ? undefined : await tryReadIndex(indexPath);
    const documents = await scanDocuments(repoRoot, existingIndex, {
      maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    });
    // One `git log` walk per index build, not per search — recency doesn't
    // change per-query, so it's cached here like searchStats and reused
    // by every search() call until the next index() run.
    const gitActivity = await collectGitActivity(repoRoot);
    const index: LocalIndex = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      indexVersion: INDEX_VERSION,
      repoRoot,
      documents,
      stats: createStats(documents),
      searchStats: computeSearchStats(documents),
      gitActivity
    };
    const mode = options.rebuild ? "rebuild" : existingIndex ? "incremental" : "full";

    await mkdir(getArtifactDirectoryPath(repoRoot, "index"), { recursive: true });
    await writeJsonFile(indexPath, index);
    await writeJsonFile(statusPath, createStatus(repoRoot, index));

    return {
      repoRoot,
      index,
      indexPath,
      statusPath,
      mode
    };
  }

  async search(options: SearchOptions): Promise<SearchResponse> {
    const startPath = path.resolve(options.startPath ?? process.cwd());
    const repoRoot = await resolveRepoRoot(startPath, options.strictRoot);
    const fanOut = await resolveRegisteredRepos(repoRoot);

    // A workspace root holds no code of its own — its index covers little more
    // than workspace.json. Searching it directly is what made every agent
    // report an empty repo. Answer for the registered repos instead.
    if (fanOut.length > 0) {
      return this.searchAcrossFanOut(repoRoot, fanOut, options);
    }

    return this.searchSingleRepo(repoRoot, options);
  }

  private async searchSingleRepo(
    repoRoot: string,
    options: SearchOptions
  ): Promise<SearchResponse> {
    const index = await this.readOrCreateIndex(repoRoot, options.strictRoot);
    // Read-only: if a symbol graph has already been built (via `graph` /
    // get_symbol_graph), search gets a free ranking boost. Never builds one
    // itself — that's a full AST parse of the repo and too expensive to run
    // on every search call.
    const graph = await tryReadGraph(repoRoot);
    const results = searchIndex(index, options.query, options.limit ?? 20, graph);

    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      query: options.query,
      repoRoot,
      results
    };
  }

  /**
   * Lists what the index actually contains. Search needs a query, and an
   * agent asked to analyze a whole repo has none to give — guessing English
   * keywords finds nothing in a codebase whose identifiers are `OrderService`
   * rather than `main`. This is the enumeration path for that case.
   */
  async listFiles(options: ListFilesOptions = {}): Promise<RepoFileInventory> {
    const startPath = path.resolve(options.startPath ?? process.cwd());
    const repoRoot = await resolveRepoRoot(startPath, options.strictRoot);
    const fanOut = await resolveRegisteredRepos(repoRoot);

    if (fanOut.length > 0) {
      return this.listFilesAcrossFanOut(repoRoot, fanOut, options);
    }

    return this.listFilesSingleRepo(repoRoot, options);
  }

  private async listFilesSingleRepo(
    repoRoot: string,
    options: ListFilesOptions
  ): Promise<RepoFileInventory> {
    const index = await this.readOrCreateIndex(repoRoot, options.strictRoot);

    const languageCounts: Record<string, number> = {};
    const directoryCounts: Record<string, number> = {};
    for (const document of index.documents) {
      languageCounts[document.languageGuess] =
        (languageCounts[document.languageGuess] ?? 0) + 1;
      const topLevel = document.relativePath.split("/")[0] ?? ".";
      const bucket = topLevel === document.relativePath ? "(root)" : topLevel;
      directoryCounts[bucket] = (directoryCounts[bucket] ?? 0) + 1;
    }

    const filter = options.filter?.toLowerCase();
    const matching = filter
      ? index.documents.filter((document) =>
          document.relativePath.toLowerCase().includes(filter)
        )
      : index.documents;

    // Source first, then tests, then config/docs — a truncated list still
    // shows the files that explain what the repo does.
    const ranked = [...matching].sort(
      (left, right) =>
        rankForListing(left) - rankForListing(right) ||
        left.relativePath.localeCompare(right.relativePath)
    );
    const files = ranked.slice(0, options.limit ?? DEFAULT_LIST_LIMIT);

    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      repoRoot,
      totalFiles: index.documents.length,
      returnedFiles: files.length,
      languageCounts,
      directoryCounts,
      files: files.map((document) => ({
        relativePath: document.relativePath,
        languageGuess: document.languageGuess,
        sizeBytes: document.fileSizeBytes,
        isTestFile: document.isTestFile,
        isConfigFile: document.isConfigFile,
        isDocFile: document.isDocFile,
        symbols: document.symbols.map((symbol) => symbol.name).slice(0, 20)
      }))
    };
  }

  /**
   * Search every registered repo and merge. One repo that has never been
   * indexed must not blank the whole answer, so a failing repo is skipped
   * rather than thrown — a partial answer beats "the repo is empty".
   */
  private async searchAcrossFanOut(
    workspaceRoot: string,
    repos: WorkspaceRepoDescriptor[],
    options: SearchOptions
  ): Promise<SearchResponse> {
    const limit = options.limit ?? 20;
    const merged: WorkspaceSearchResult[] = [];
    const seen = new Set<string>();

    for (const repo of repos) {
      const response = await this.searchSingleRepo(repo.repoRoot, {
        ...options,
        startPath: repo.repoRoot,
        limit
      }).catch(() => undefined);

      for (const result of response?.results ?? []) {
        // A repo nested inside the workspace root can be reached twice.
        if (seen.has(result.filePath)) continue;
        seen.add(result.filePath);
        merged.push({
          ...result,
          repoName: repo.name,
          repoRole: repo.role,
          repoRoot: repo.repoRoot
        });
      }
    }

    merged.sort(
      (left, right) =>
        right.score - left.score ||
        left.repoName.localeCompare(right.repoName) ||
        left.relativePath.localeCompare(right.relativePath)
    );

    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      query: options.query,
      repoRoot: workspaceRoot,
      results: merged.slice(0, limit)
    };
  }

  /** The enumeration counterpart of searchAcrossFanOut. */
  private async listFilesAcrossFanOut(
    workspaceRoot: string,
    repos: WorkspaceRepoDescriptor[],
    options: ListFilesOptions
  ): Promise<RepoFileInventory> {
    const languageCounts: Record<string, number> = {};
    const directoryCounts: Record<string, number> = {};
    const repoSummaries: RepoFileInventoryRepo[] = [];
    const entries: RepoFileEntry[] = [];
    const seen = new Set<string>();
    let totalFiles = 0;

    for (const repo of repos) {
      const inventory = await this.listFilesSingleRepo(repo.repoRoot, {
        ...options,
        // Rank and cap once over the merged list, not per repo — otherwise a
        // repo's best files get cut before they compete with the others.
        limit: Number.MAX_SAFE_INTEGER
      }).catch(() => undefined);

      if (!inventory) {
        repoSummaries.push({ name: repo.name, repoRoot: repo.repoRoot, totalFiles: 0 });
        continue;
      }

      totalFiles += inventory.totalFiles;
      repoSummaries.push({
        name: repo.name,
        repoRoot: repo.repoRoot,
        totalFiles: inventory.totalFiles
      });

      for (const [language, count] of Object.entries(inventory.languageCounts)) {
        languageCounts[language] = (languageCounts[language] ?? 0) + count;
      }
      // Keyed by repo so two repos that both have a `src/` stay distinguishable.
      for (const [directory, count] of Object.entries(inventory.directoryCounts)) {
        const key = `${repo.name}/${directory}`;
        directoryCounts[key] = (directoryCounts[key] ?? 0) + count;
      }

      for (const entry of inventory.files) {
        const key = path.join(repo.repoRoot, entry.relativePath);
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ ...entry, repoName: repo.name });
      }
    }

    const ranked = entries.sort(
      (left, right) =>
        rankEntryForListing(left) - rankEntryForListing(right) ||
        (left.repoName ?? "").localeCompare(right.repoName ?? "") ||
        left.relativePath.localeCompare(right.relativePath)
    );
    const files = ranked.slice(0, options.limit ?? DEFAULT_LIST_LIMIT);

    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      repoRoot: workspaceRoot,
      totalFiles,
      returnedFiles: files.length,
      languageCounts,
      directoryCounts,
      repos: repoSummaries,
      files
    };
  }

  async findSimilarFeatures(options: SimilarFeatureOptions): Promise<SearchResponse> {
    const response = await this.search(options);

    return {
      ...response,
      results: response.results.filter(
        (result) => !result.isConfigFile || result.isTestFile || result.isDocFile
      )
    };
  }

  async status(startPath = process.cwd()): Promise<IndexStatus> {
    const repoRoot = await findRepoRoot(path.resolve(startPath));
    const indexPath = getIndexPath(repoRoot);
    const statusPath = getStatusPath(repoRoot);
    const index = await tryReadIndex(indexPath);

    return createStatus(repoRoot, index, indexPath, statusPath);
  }

  async indexWorkspace(
    options: WorkspaceIndexOptions = {}
  ): Promise<WorkspaceIndexResult> {
    const workspaceService = new WorkspaceService();
    const workspaceMap = await workspaceService.createWorkspaceMap({
      startPath: options.startPath
    });
    const results = [];

    for (const repo of workspaceMap.repos) {
      results.push({
        repo,
        result: await this.index({
          startPath: repo.repoRoot,
          rebuild: options.rebuild,
          maxFileBytes: options.maxFileBytes
        })
      });
    }

    return {
      workspace: workspaceMap.workspace,
      workspacePath: workspaceMap.workspacePath,
      repoMapPath: workspaceMap.repoMapPath,
      repos: workspaceMap.repos,
      results
    };
  }

  async searchWorkspace(
    options: WorkspaceSearchOptions
  ): Promise<WorkspaceSearchResponse> {
    const workspaceService = new WorkspaceService();
    const workspace = await workspaceService.show({ startPath: options.startPath });
    const repos = workspaceService.resolveRepos(workspace.workspace);
    const results = [];

    for (const repo of repos) {
      results.push({
        repo,
        response: await this.search({
          startPath: repo.repoRoot,
          query: options.query,
          limit: options.limit
        })
      });
    }

    const combinedResults = combineWorkspaceResults(results);

    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      query: options.query,
      workspace: workspace.workspace,
      repos,
      results,
      combinedResults
    };
  }

  private async readOrCreateIndex(
    repoRoot: string,
    strictRoot?: boolean
  ): Promise<LocalIndex> {
    const index = await tryReadIndex(getIndexPath(repoRoot));

    if (index) {
      return index;
    }

    return (await this.index({ startPath: repoRoot, strictRoot })).index;
  }
}

const DEFAULT_LIST_LIMIT = 300;

/** Source (0) before tests (1) before config/docs (2). */
function rankForListing(document: IndexedFile): number {
  if (document.isTestFile) return 1;
  if (document.isConfigFile || document.isDocFile) return 2;
  return 0;
}

/** Same ordering as rankForListing, over an already-projected entry. */
function rankEntryForListing(entry: RepoFileEntry): number {
  if (entry.isTestFile) return 1;
  if (entry.isConfigFile || entry.isDocFile) return 2;
  return 0;
}

function combineWorkspaceResults(
  entries: Array<{
    repo: WorkspaceRepoDescriptor;
    response: SearchResponse;
  }>
): WorkspaceSearchResult[] {
  return entries
    .flatMap((entry) =>
      entry.response.results.map((result) => ({
        ...result,
        repoName: entry.repo.name,
        repoRole: entry.repo.role,
        repoRoot: entry.repo.repoRoot
      }))
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.repoName.localeCompare(right.repoName) ||
        left.relativePath.localeCompare(right.relativePath)
    );
}

async function scanDocuments(
  repoRoot: string,
  existingIndex: LocalIndex | undefined,
  options: { maxFileBytes: number }
): Promise<IndexedFile[]> {
  const existingByPath = new Map(
    existingIndex?.documents.map((document) => [document.relativePath, document]) ?? []
  );
  const entries = await scanRepository(repoRoot);
  const documents: IndexedFile[] = [];

  for (const entry of entries) {
    const document = await indexEntry(entry, existingByPath, options);
    if (document) {
      documents.push(document);
    }
  }

  return documents.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath)
  );
}

async function indexEntry(
  entry: ScannedEntry,
  existingByPath: Map<string, IndexedFile>,
  options: { maxFileBytes: number }
): Promise<IndexedFile | undefined> {
  if (entry.sizeBytes > options.maxFileBytes || isBinaryPath(entry.relativePath)) {
    return undefined;
  }

  const text = await readTextFile(entry.absolutePath);
  if (text === undefined) {
    return undefined;
  }

  const contentHash = sha256(text);
  const existing = existingByPath.get(entry.relativePath);

  if (
    existing &&
    existing.contentHash === contentHash &&
    existing.fileSizeBytes === entry.sizeBytes &&
    existing.modifiedTimeMs === entry.modifiedTimeMs
  ) {
    // Backfill search tokens for documents indexed before this field existed,
    // so every written index has complete precomputed search data.
    return existing.searchTokens
      ? existing
      : { ...existing, searchTokens: computeDocumentTokens(existing) };
  }

  return createIndexedFile({
    fullPath: entry.absolutePath,
    relativePath: entry.relativePath,
    text,
    contentHash,
    modifiedTimeMs: entry.modifiedTimeMs,
    fileSizeBytes: entry.sizeBytes
  });
}

function createIndexedFile(input: {
  fullPath: string;
  relativePath: string;
  text: string;
  contentHash: string;
  modifiedTimeMs: number;
  fileSizeBytes: number;
}): IndexedFile {
  const extension = path.extname(input.relativePath);
  const file: IndexedFile = {
    filePath: input.fullPath,
    relativePath: input.relativePath,
    extension,
    languageGuess: guessLanguage(input.relativePath),
    contentHash: input.contentHash,
    modifiedTimeMs: input.modifiedTimeMs,
    fileSizeBytes: input.fileSizeBytes,
    textPreview: input.text.slice(0, PREVIEW_LENGTH),
    symbols: extractSymbols(input.relativePath, input.text),
    imports: extractImports(input.text),
    isTestFile: isTestFile(input.relativePath),
    isConfigFile: isConfigFile(input.relativePath),
    isDocFile: isDocFile(input.relativePath),
    indexedAt: new Date().toISOString()
  };

  return { ...file, searchTokens: computeDocumentTokens(file) };
}

// --- Hybrid search: BM25 (lexical) + path/symbol signal (structural) fused via RRF ---
//
// Two complementary signals:
//   Lexical  — BM25 with camelCase tokenization, field weights, and IDF length normalization.
//   Structural — fraction of query terms found in file path and symbol names. This is the
//               right "semantic" signal for code search: a file called invoiceApproval.ts
//               with a symbol approveInvoice is structurally about "invoice approval"
//               regardless of how long or short its content is. TF-IDF cosine was
//               avoided here because it rewards very short documents that happen to
//               contain all query terms (e.g. a 3-word README beats a rich source file).
// Results are fused via Reciprocal Rank Fusion (RRF).

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const chunk of text.split(/[^a-zA-Z0-9]+/)) {
    if (!chunk) continue;
    // Split camelCase ("invoiceApproval" → ["invoice","Approval"]),
    // acronym boundaries ("HTTPSClient" → ["HTTPS","Client"]), and
    // digit boundaries ("R2D2Service" → ["R2D2","Service"]). Without the
    // last rule an identifier carrying a digit stays one opaque token, so
    // searching "R2D2" could not reach R2D2Service at all.
    for (const sub of chunk.split(
      /(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[0-9])(?=[A-Z][a-z])/
    )) {
      const lower = sub.toLowerCase();
      if (lower.length >= 2) tokens.push(lower);
    }
  }
  return tokens;
}

function tokenCounts(text: string): TokenCounts {
  const counts: TokenCounts = {};
  for (const token of tokenize(text)) {
    counts[token] = (counts[token] ?? 0) + 1;
  }
  return counts;
}

function computeDocumentTokens(doc: IndexedFile): DocumentTokens {
  return {
    path: tokenCounts(doc.relativePath),
    symbols: tokenCounts(doc.symbols.map((symbol) => symbol.name).join(" ")),
    preview: tokenCounts(doc.textPreview),
    imports: tokenCounts(doc.imports.join(" "))
  };
}

function documentTokensFor(doc: IndexedFile): DocumentTokens {
  return doc.searchTokens ?? computeDocumentTokens(doc);
}

function fieldLength(counts: TokenCounts): number {
  let total = 0;
  for (const value of Object.values(counts)) total += value;
  return total;
}

// Precompute corpus IDF + average length once per index build (persisted in
// index.json) so search no longer rebuilds these over the whole corpus per query.
function computeSearchStats(documents: IndexedFile[]): SearchStats {
  const termDocFreq: TokenCounts = {};
  let totalLength = 0;
  const fieldTotals: Record<string, number> = {};

  for (const doc of documents) {
    const tokens = documentTokensFor(doc);
    const seen = new Set<string>();
    let docLength = 0;
    for (const [fieldName, counts] of Object.entries(tokens) as [
      string,
      TokenCounts
    ][]) {
      const fl = fieldLength(counts);
      fieldTotals[fieldName] = (fieldTotals[fieldName] ?? 0) + fl;
      docLength += fl;
      for (const term of Object.keys(counts)) {
        if (!seen.has(term)) {
          seen.add(term);
          termDocFreq[term] = (termDocFreq[term] ?? 0) + 1;
        }
      }
    }
    totalLength += docLength;
  }

  const n = documents.length;
  const avgFieldLengths: Record<string, number> = {};
  for (const [fieldName, total] of Object.entries(fieldTotals)) {
    avgFieldLengths[fieldName] = n > 0 ? total / n : 1;
  }

  return {
    docCount: n,
    avgDocLength: n > 0 ? totalLength / n : 1,
    termDocFreq,
    avgFieldLengths
  };
}

function bm25Score(
  fields: DocumentTokens,
  queryTerms: string[],
  stats: SearchStats
): { score: number; matchedFields: Set<string> } {
  const matchedFields = new Set<string>();
  let total = 0;
  const fieldEntries = Object.entries(fields);

  for (const term of queryTerms) {
    const df = stats.termDocFreq[term] ?? 0;
    if (df === 0) continue;
    const idf = Math.log((stats.docCount - df + 0.5) / (df + 0.5) + 1);
    for (const [fieldName, counts] of fieldEntries) {
      const tf = counts[term] ?? 0;
      if (tf === 0) continue;
      matchedFields.add(fieldName);
      const weight = FIELD_WEIGHTS[fieldName] ?? 1;
      const dl = fieldLength(counts);
      // Use the per-field average so that a long preview field and a short path
      // field are each normalized against their own corpus average, rather than
      // dividing the total average equally across all 4 fields.
      const avgFieldLength =
        stats.avgFieldLengths?.[fieldName] ??
        stats.avgDocLength / Math.max(fieldEntries.length, 1);
      const ntf =
        (tf * (BM25_K1 + 1)) /
        (tf + BM25_K1 * (1 - BM25_B + (BM25_B * dl) / avgFieldLength));
      total += weight * idf * ntf;
    }
  }

  return { score: total, matchedFields };
}

function pathSymbolScore(fields: DocumentTokens, queryTerms: string[]): number {
  if (queryTerms.length === 0) return 0;
  let matches = 0;
  for (const term of queryTerms) {
    if (fields.path[term]) matches++;
    if (fields.symbols[term]) matches++;
  }
  return matches / (queryTerms.length * 2);
}

// Best symbol whose name shares the most query terms — gives file:line precision.
function bestSymbolAnchor(
  doc: IndexedFile,
  queryTerms: string[]
): SearchAnchor | undefined {
  let best: { symbol: CodeSymbol; matches: number } | undefined;

  for (const symbol of doc.symbols) {
    const nameTokens = new Set(tokenize(symbol.name));
    let matches = 0;
    for (const term of queryTerms) {
      if (nameTokens.has(term)) matches++;
    }
    if (matches > 0 && (!best || matches > best.matches)) {
      best = { symbol, matches };
    }
  }

  if (!best) return undefined;

  return {
    symbol: best.symbol.name,
    kind: best.symbol.kind,
    line: best.symbol.startLine
  };
}

const GRAPH_SEED_COUNT = 8;

type RankedItem = { relativePath: string; score: number };
type RankedSignal = { name: SearchSignal; ranked: RankedItem[] };

function searchIndex(
  index: LocalIndex,
  query: string,
  limit: number,
  graph?: SymbolGraph
): SearchResult[] {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) return [];

  const stats = index.searchStats ?? computeSearchStats(index.documents);

  type Entry = {
    doc: IndexedFile;
    lexical: number;
    semantic: number;
    matchedFields: Set<string>;
  };

  const entries: Entry[] = index.documents.map((doc) => {
    const fields = documentTokensFor(doc);
    const { score: lexical, matchedFields } = bm25Score(fields, queryTerms, stats);
    const semantic = pathSymbolScore(fields, queryTerms);
    return { doc, lexical, semantic, matchedFields };
  });
  const entriesByPath = new Map(
    entries.map((entry) => [entry.doc.relativePath, entry])
  );

  const byLexical: RankedItem[] = [...entries]
    .sort((a, b) => b.lexical - a.lexical)
    .map((entry) => ({ relativePath: entry.doc.relativePath, score: entry.lexical }));
  const bySemantic: RankedItem[] = [...entries]
    .sort((a, b) => b.semantic - a.semantic)
    .map((entry) => ({ relativePath: entry.doc.relativePath, score: entry.semantic }));

  const rankedSignals: RankedSignal[] = [
    { name: "lexical", ranked: byLexical },
    { name: "structural", ranked: bySemantic }
  ];

  // Graph signal: surfaces files connected to a top keyword/structural
  // match via the symbol/dependency graph, even when they share no
  // vocabulary with the query at all — e.g. a retry utility called by the
  // payment service the query actually named. Only added when a graph has
  // already been built (see tryReadGraph) and the keyword/structural
  // signals found at least one seed to traverse from.
  if (graph) {
    const seeds = pickSeedFiles([byLexical, bySemantic], GRAPH_SEED_COUNT);
    if (seeds.length > 0) {
      const adjacency = buildFileAdjacency(graph);
      const graphRanked = graphProximityScores(
        seeds,
        adjacency,
        new Set(entriesByPath.keys())
      );
      if (graphRanked.length > 0) {
        rankedSignals.push({ name: "graph", ranked: graphRanked });
      }
    }
  }

  // Recency signal: frequently/recently changed files rank slightly higher,
  // independent of the query — active-development areas are more often
  // where a new change belongs. Precomputed at index time (see index()).
  const gitActivity = index.gitActivity ?? [];
  if (gitActivity.length > 0) {
    const activityByPath = new Map(
      gitActivity.map((activity) => [activity.filePath, activity])
    );
    const recencyRanked: RankedItem[] = entries
      .map((entry) => ({
        relativePath: entry.doc.relativePath,
        score: activityByPath.get(entry.doc.relativePath)?.commitCount ?? 0
      }))
      .sort((a, b) => b.score - a.score);
    rankedSignals.push({ name: "recency", ranked: recencyRanked });
  }

  const fused = fuseSignals(rankedSignals);

  return [...fused.entries()]
    .map(([relativePath, value]) => ({
      relativePath,
      ...value,
      entry: entriesByPath.get(relativePath)
    }))
    .filter((item): item is typeof item & { entry: Entry } => Boolean(item.entry))
    .sort((a, b) => b.rrf - a.rrf || a.relativePath.localeCompare(b.relativePath))
    .slice(0, limit)
    .map(({ entry, rrf, signals }) => ({
      filePath: entry.doc.filePath,
      relativePath: entry.doc.relativePath,
      score: Math.round(rrf * 1000 * 100) / 100,
      languageGuess: entry.doc.languageGuess,
      textPreview: entry.doc.textPreview,
      matchedFields: [...entry.matchedFields].sort(),
      symbols: entry.doc.symbols,
      imports: entry.doc.imports,
      isTestFile: entry.doc.isTestFile,
      isConfigFile: entry.doc.isConfigFile,
      isDocFile: entry.doc.isDocFile,
      anchor: bestSymbolAnchor(entry.doc, queryTerms),
      signals: [...signals].sort()
    }));
}

/** Reciprocal Rank Fusion over any number of ranked signal lists, tracking
 *  which signals contributed to each result (for SearchResult.signals). */
function fuseSignals(
  signals: RankedSignal[]
): Map<string, { rrf: number; signals: Set<SearchSignal> }> {
  const rrfMap = new Map<string, { rrf: number; signals: Set<SearchSignal> }>();

  for (const { name, ranked } of signals) {
    for (let i = 0; i < ranked.length; i++) {
      const item = ranked[i];
      if (item.score <= 0) break;
      const existing = rrfMap.get(item.relativePath);
      const signalSet = existing?.signals ?? new Set<SearchSignal>();
      signalSet.add(name);
      rrfMap.set(item.relativePath, {
        rrf: (existing?.rrf ?? 0) + 1 / (RRF_K + i + 1),
        signals: signalSet
      });
    }
  }

  return rrfMap;
}

/** Top-N non-zero-scoring files from each ranked list, deduped — the
 *  starting points graph traversal expands from. */
function pickSeedFiles(rankedLists: RankedItem[][], perListCount: number): string[] {
  const seeds = new Set<string>();

  for (const ranked of rankedLists) {
    let taken = 0;
    for (const item of ranked) {
      if (item.score <= 0 || taken >= perListCount) break;
      seeds.add(item.relativePath);
      taken += 1;
    }
  }

  return [...seeds];
}

/** Undirected file-level adjacency collapsed from the graph's symbol-level
 *  edges — "related to" is symmetric for retrieval purposes regardless of
 *  which direction an import/call/heritage edge points. */
function buildFileAdjacency(graph: SymbolGraph): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();

  const link = (from: string, to: string): void => {
    if (from === to) return;
    if (!adjacency.has(from)) adjacency.set(from, new Set());
    adjacency.get(from)?.add(to);
  };

  for (const edge of graph.edges) {
    const from = fileOfNodeId(edge.from);
    const to = fileOfNodeId(edge.to);
    link(from, to);
    link(to, from);
  }

  return adjacency;
}

function fileOfNodeId(nodeId: string): string {
  const hashIndex = nodeId.indexOf("#");
  return hashIndex === -1 ? nodeId : nodeId.slice(0, hashIndex);
}

/** 1-hop neighbors of a seed score higher than 2-hop neighbors; seeds
 *  themselves are excluded — they already rank highly on lexical/structural
 *  signal, so the graph signal's value is surfacing files that don't. */
function graphProximityScores(
  seeds: string[],
  adjacency: Map<string, Set<string>>,
  knownPaths: Set<string>
): RankedItem[] {
  const seedSet = new Set(seeds);
  const scores = new Map<string, number>();

  for (const seed of seeds) {
    for (const neighbor of adjacency.get(seed) ?? []) {
      if (seedSet.has(neighbor) || !knownPaths.has(neighbor)) continue;
      scores.set(neighbor, Math.max(scores.get(neighbor) ?? 0, 2));
    }
  }

  for (const oneHopFile of [...scores.keys()]) {
    for (const neighbor of adjacency.get(oneHopFile) ?? []) {
      if (seedSet.has(neighbor) || scores.has(neighbor) || !knownPaths.has(neighbor)) {
        continue;
      }
      scores.set(neighbor, 1);
    }
  }

  return [...scores.entries()]
    .map(([relativePath, score]) => ({ relativePath, score }))
    .sort((a, b) => b.score - a.score);
}

function extractSymbols(filePath: string, text: string): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const patterns = [
    /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /\bfunction\s+([A-Za-z_$][\w$]*)/g,
    /\bclass\s+([A-Za-z_$][\w$]*)/g,
    /\binterface\s+([A-Za-z_$][\w$]*)/g,
    /\bdef\s+([A-Za-z_][\w]*)/g,
    /\bpublic\s+(?:final\s+)?class\s+([A-Za-z_][\w]*)/g
  ] as const;

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];

      if (!name) {
        continue;
      }

      symbols.push({
        name,
        kind: inferSymbolKind(match[0]),
        filePath,
        startLine: lineNumberAt(text, match.index ?? 0)
      });
    }
  }

  return dedupeSymbols(symbols).slice(0, 100);
}

function extractImports(text: string): string[] {
  const imports = new Set<string>();
  const patterns = [
    /^\s*import\s+.*?\s+from\s+["']([^"']+)["']/gm,
    /^\s*import\s+["']([^"']+)["']/gm,
    /^\s*from\s+([\w.]+)\s+import\s+/gm,
    /^\s*import\s+([\w.]+)/gm,
    /^\s*#include\s+[<"]([^>"]+)[>"]/gm,
    /^\s*include\s+["']?([^"'\s]+)["']?/gm,
    /require\(["']([^"']+)["']\)/g
  ] as const;

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (match[1]) {
        imports.add(match[1]);
      }
    }
  }

  return [...imports].sort((left, right) => left.localeCompare(right)).slice(0, 100);
}

function createStats(documents: IndexedFile[]): IndexStats {
  const languageCounts: Record<string, number> = {};

  for (const document of documents) {
    languageCounts[document.languageGuess] =
      (languageCounts[document.languageGuess] ?? 0) + 1;
  }

  return {
    documentCount: documents.length,
    indexedFileCount: documents.length,
    skippedFileCount: 0,
    totalBytes: documents.reduce(
      (total, document) => total + document.fileSizeBytes,
      0
    ),
    languageCounts,
    testFileCount: documents.filter((document) => document.isTestFile).length,
    configFileCount: documents.filter((document) => document.isConfigFile).length,
    docFileCount: documents.filter((document) => document.isDocFile).length
  };
}

function createStatus(
  repoRoot: string,
  index: LocalIndex | undefined,
  indexPath = getIndexPath(repoRoot),
  statusPath = getStatusPath(repoRoot)
): IndexStatus {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    repoRoot,
    indexPath,
    statusPath,
    documentCount: index?.documents.length ?? 0,
    lastIndexedAt: index?.generatedAt,
    exists: Boolean(index)
  };
}

async function findRepoRoot(startPath: string): Promise<string> {
  const startStats = await stat(startPath);
  let current = startStats.isDirectory() ? startPath : path.dirname(startPath);

  while (true) {
    if (await pathExists(path.join(current, ".git"))) {
      return current;
    }

    const parent = path.dirname(current);

    if (parent === current) {
      return startStats.isDirectory() ? startPath : path.dirname(startPath);
    }

    current = parent;
  }
}

async function resolveRepoRoot(
  startPath: string,
  strictRoot: boolean | undefined
): Promise<string> {
  if (!strictRoot) {
    return findRepoRoot(startPath);
  }

  const startStats = await stat(startPath);
  return startStats.isDirectory() ? startPath : path.dirname(startPath);
}

async function tryReadIndex(indexPath: string): Promise<LocalIndex | undefined> {
  try {
    return await readJsonFile<LocalIndex>(indexPath);
  } catch {
    return undefined;
  }
}

async function tryReadGraph(repoRoot: string): Promise<SymbolGraph | undefined> {
  try {
    return await readJsonFile<SymbolGraph>(getArtifactFilePath(repoRoot, "graph"));
  } catch {
    return undefined;
  }
}

async function readTextFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function getIndexPath(repoRoot: string): string {
  return path.join(getArtifactDirectoryPath(repoRoot, "index"), INDEX_FILE_NAME);
}

function getStatusPath(repoRoot: string): string {
  return path.join(getArtifactDirectoryPath(repoRoot, "index"), STATUS_FILE_NAME);
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function guessLanguage(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath).toLowerCase();

  if ([".ts", ".tsx", ".mts", ".cts"].includes(extension)) return "TypeScript";
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) return "JavaScript";
  if (extension === ".py") return "Python";
  if (extension === ".java") return "Java";
  if ([".md", ".rst"].includes(extension)) return "Markdown";
  if ([".json", ".yaml", ".yml", ".toml", ".ini", ".cfg"].includes(extension)) {
    return "Config";
  }
  if (extension === ".sql") return "SQL";
  if ([".sh", ".bash", ".zsh"].includes(extension)) return "Shell";
  if (name === "dockerfile" || name === "makefile") return "Config";

  return extension ? extension.slice(1).toUpperCase() : "Text";
}

function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const name = path.basename(lower);
  return (
    lower.includes("/test/") ||
    lower.includes("/tests/") ||
    lower.includes("/__tests__/") ||
    lower.includes("/spec/") ||
    name.includes(".test.") ||
    name.includes(".spec.") ||
    name.startsWith("test_")
  );
}

function isConfigFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  const name = path.basename(lower);
  return (
    lower.endsWith(".json") ||
    lower.endsWith(".yaml") ||
    lower.endsWith(".yml") ||
    lower.endsWith(".toml") ||
    lower.endsWith(".ini") ||
    lower.endsWith(".cfg") ||
    lower.endsWith(".xml") ||
    hasConfigNaming(lower) ||
    lower.endsWith(".gradle") ||
    lower.endsWith(".gradle.kts") ||
    lower.endsWith(".csproj") ||
    lower.endsWith(".vbproj") ||
    lower.endsWith(".fsproj") ||
    lower.endsWith(".sln") ||
    // Dependency manifests with no telling extension. Missing these left an
    // auditor filtering on isConfigFile blind to whole ecosystems.
    /^requirements(-[\w.]+)?\.txt$/.test(name) ||
    DEPENDENCY_MANIFESTS.has(name)
  );
}

/**
 * "config" as a path segment or a dot-delimited filename token — `vite.config.ts`
 * and `src/config/app.ts`, but not `SecurityConfig.java`. A plain substring match
 * swallowed every CamelCase class whose name happened to end in Config, which then
 * dropped them out of findSimilarFeatures and demoted them in a capped listing.
 */
function hasConfigNaming(lowerPath: string): boolean {
  const segments = lowerPath.split("/");
  const name = segments.pop() ?? "";
  if (segments.some((segment) => segment === "config" || segment === "conf")) {
    return true;
  }
  return name.split(".").some((part) => part === "config" || part === "conf");
}

const DEPENDENCY_MANIFESTS = new Set([
  "dockerfile",
  "makefile",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "pom.xml",
  "build.gradle",
  "settings.gradle",
  "gemfile",
  "gemfile.lock",
  "go.mod",
  "go.sum",
  "cargo.toml",
  "cargo.lock",
  "pipfile",
  "pipfile.lock",
  "poetry.lock",
  "composer.json",
  "composer.lock",
  "build.sbt",
  "project.clj",
  "podfile",
  "packages.config"
]);

function isDocFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith(".md") || lower.startsWith("docs/") || lower.endsWith(".rst");
}

function inferSymbolKind(matchText: string): string {
  if (matchText.includes("class")) return "class";
  if (matchText.includes("interface")) return "interface";
  if (matchText.includes("def ")) return "function";
  return "function";
}

function lineNumberAt(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

function dedupeSymbols(symbols: CodeSymbol[]): CodeSymbol[] {
  const byKey = new Map<string, CodeSymbol>();

  for (const symbol of symbols) {
    byKey.set(`${symbol.kind}:${symbol.name}:${symbol.startLine ?? ""}`, symbol);
  }

  return [...byKey.values()];
}
