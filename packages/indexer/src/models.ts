import type { CodeSymbol, FileChangeActivity } from "@copilot-architect/shared";
import type {
  WorkspaceRepoDescriptor,
  WorkspaceServiceResult
} from "@copilot-architect/core";

export interface LocalIndex {
  schemaVersion: string;
  generatedAt: string;
  indexVersion: string;
  repoRoot: string;
  documents: IndexedFile[];
  stats: IndexStats;
  /**
   * Corpus-level search statistics precomputed at index time so hybrid search
   * does not have to rebuild IDF over the whole corpus on every query.
   * Optional for backward compatibility with indexes written before this field.
   */
  searchStats?: SearchStats;
  /**
   * Git recency/frequency signal, precomputed at index time (one `git log`
   * walk) rather than re-shelling out to git on every search call. Optional
   * for backward compatibility with indexes written before this field; empty
   * when the repo has no `.git` directory or git is unavailable.
   */
  gitActivity?: FileChangeActivity[];
  /**
   * Fingerprint of the file scan this index was built from, used to tell
   * cheaply whether the index still describes what is on disk. Optional for
   * backward compatibility: an index written before this field is treated as
   * stale once, which repopulates it.
   */
  scanSignature?: ScanSignature;
  /**
   * `.git/HEAD` as it stood when this index was built. A different value means
   * the working tree was switched to another branch, which the timestamp
   * signature can miss inside its short caching window.
   */
  gitHead?: string;
}

/** How many files the scan saw, and the newest mtime among them. */
export interface ScanSignature {
  fileCount: number;
  maxModifiedTimeMs: number;
}

/** Token frequency map for one document field (token -> occurrence count). */
export type TokenCounts = Record<string, number>;

/** Precomputed per-field tokenizations for a single document. */
export interface DocumentTokens {
  path: TokenCounts;
  symbols: TokenCounts;
  preview: TokenCounts;
  imports: TokenCounts;
}

/** Corpus-wide statistics required for BM25 ranking. */
export interface SearchStats {
  docCount: number;
  avgDocLength: number;
  termDocFreq: TokenCounts;
  /**
   * Per-field average token count (path, symbols, preview, imports). Precomputed
   * so BM25 can normalize each field against its own average rather than using
   * `avgDocLength / numFields`, which under-normalizes long preview fields and
   * over-normalizes short path fields. Optional for backward compatibility with
   * indexes written before this field was introduced.
   */
  avgFieldLengths?: Record<string, number>;
}

export interface IndexedFile {
  filePath: string;
  relativePath: string;
  extension: string;
  languageGuess: string;
  contentHash: string;
  modifiedTimeMs: number;
  fileSizeBytes: number;
  textPreview: string;
  symbols: CodeSymbol[];
  imports: string[];
  isTestFile: boolean;
  isConfigFile: boolean;
  isDocFile: boolean;
  indexedAt: string;
  /**
   * Precomputed per-field token counts used by hybrid search. Optional for
   * backward compatibility; search recomputes on the fly when absent.
   */
  searchTokens?: DocumentTokens;
}

export interface IndexStats {
  documentCount: number;
  indexedFileCount: number;
  skippedFileCount: number;
  totalBytes: number;
  languageCounts: Record<string, number>;
  testFileCount: number;
  configFileCount: number;
  docFileCount: number;
}

export interface IndexStatus {
  schemaVersion: string;
  generatedAt: string;
  repoRoot: string;
  indexPath: string;
  statusPath: string;
  documentCount: number;
  lastIndexedAt?: string;
  exists: boolean;
}

export interface IndexOptions {
  startPath?: string;
  strictRoot?: boolean;
  rebuild?: boolean;
  maxFileBytes?: number;
}

export interface IndexResult {
  repoRoot: string;
  index: LocalIndex;
  indexPath: string;
  statusPath: string;
  mode: "full" | "incremental" | "rebuild";
}

export interface ListFilesOptions {
  startPath?: string;
  strictRoot?: boolean;
  /** Case-insensitive substring matched against the relative path. */
  filter?: string;
  /** Max files returned. Defaults to 300 — enough to see a repo's shape
   *  without flooding an agent's context. */
  limit?: number;
}

/**
 * The indexed file inventory. Answers "what is in this repo" without needing
 * a search term, which keyword search cannot do — an agent asked to analyze a
 * codebase has no query to guess with, and guessed English keywords
 * ("main", "app", "server") match nothing in a Java or C# codebase whose
 * identifiers are `OrderService` or `BillingController`.
 */
export interface RepoFileInventory {
  schemaVersion: string;
  generatedAt: string;
  repoRoot: string;
  /** Total indexed files, before `filter` and `limit` are applied. */
  totalFiles: number;
  /** Files actually returned; lower than totalFiles when truncated. */
  returnedFiles: number;
  /** Indexed file count per detected language. */
  languageCounts: Record<string, number>;
  /** Indexed file count per top-level directory. */
  directoryCounts: Record<string, number>;
  /**
   * Present only when the inventory spans a multi-repo workspace. Lets a caller
   * see it is looking at several repos, and which came back empty — a repo
   * listed with `totalFiles: 0` has not been indexed yet.
   */
  repos?: RepoFileInventoryRepo[];
  files: RepoFileEntry[];
}

export interface RepoFileInventoryRepo {
  name: string;
  repoRoot: string;
  totalFiles: number;
}

export interface RepoFileEntry {
  relativePath: string;
  /** Set only on a multi-repo inventory; `relativePath` is relative to it. */
  repoName?: string;
  languageGuess: string;
  sizeBytes: number;
  isTestFile: boolean;
  isConfigFile: boolean;
  isDocFile: boolean;
  /** Declared symbol names, so the shape of a file is visible without reading it. */
  symbols: string[];
}

export interface SearchOptions {
  startPath?: string;
  strictRoot?: boolean;
  query: string;
  limit?: number;
}

export interface SearchResult {
  filePath: string;
  relativePath: string;
  score: number;
  languageGuess: string;
  textPreview: string;
  matchedFields: string[];
  symbols: CodeSymbol[];
  imports: string[];
  isTestFile: boolean;
  isConfigFile: boolean;
  isDocFile: boolean;
  /**
   * Best-matching symbol for the query, giving file:line precision so callers
   * can point an agent at the relevant declaration rather than the whole file.
   */
  anchor?: SearchAnchor;
  /**
   * Which ranking signals this result was found through: "lexical" (BM25
   * keyword match), "structural" (query terms in path/symbol names), "graph"
   * (connected to a top keyword match via the symbol/dependency graph — see
   * @copilot-architect/graph), "recency" (frequently/recently changed per
   * git history). A result can carry more than one.
   */
  signals: SearchSignal[];
}

export type SearchSignal = "lexical" | "structural" | "graph" | "recency";

export interface SearchAnchor {
  symbol: string;
  kind: string;
  line?: number;
}

export interface SearchResponse {
  schemaVersion: string;
  generatedAt: string;
  query: string;
  repoRoot: string;
  results: SearchResult[];
}

/**
 * A search result projected for a model's context window.
 *
 * The internal SearchResult carries everything a caller might want; a model
 * needs far less, and the difference is expensive. Measured on this repo, one
 * `search_repo` at limit 20 cost ~24,000 tokens, of which 96% was `symbols`
 * (each redundantly repeating the parent's `filePath`) and a 4,000-character
 * `textPreview` per result. Ranking is unchanged — only the per-result payload
 * is capped.
 */
export interface ModelSearchResult {
  /** Relative to `repoName`'s root, or to the repo root when single-repo. */
  relativePath: string;
  repoName?: string;
  score: number;
  languageGuess: string;
  matchedFields: string[];
  signals: SearchSignal[];
  anchor?: SearchAnchor;
  symbols: ModelSymbol[];
  /** Symbols beyond the cap, so a caller can tell the list was truncated. */
  omittedSymbols?: number;
  preview: string;
  previewTruncated?: boolean;
  isTestFile: boolean;
  isConfigFile: boolean;
  isDocFile: boolean;
}

/** A symbol without the parent's `filePath`, which the result already carries. */
export interface ModelSymbol {
  name: string;
  kind: string;
  line?: number;
}

export interface ModelSearchResponse {
  schemaVersion: string;
  generatedAt: string;
  query: string;
  repoRoot: string;
  results: ModelSearchResult[];
}

export interface ModelShapeOptions {
  /** Symbols kept per result. Defaults to 12. */
  maxSymbols?: number;
  /** Preview characters kept per result. Defaults to 400. */
  previewChars?: number;
}

/**
 * A file inventory projected for a model's context window.
 *
 * The per-file JSON object is the wrong shape here: 300 files each repeating
 * `relativePath`, `languageGuess`, `sizeBytes`, `isTestFile`, `isConfigFile`
 * and `isDocFile` spent roughly half the payload on keys rather than content.
 * One line per file carries the same facts at a fraction of the cost, and a
 * model reads a table as readily as an object graph.
 */
export interface ModelRepoInventory {
  schemaVersion: string;
  generatedAt: string;
  repoRoot: string;
  totalFiles: number;
  returnedFiles: number;
  languageCounts: Record<string, number>;
  repos?: RepoFileInventoryRepo[];
  /** `path|language|kind|symbols` where kind is one of `-` `T` `C` `D`. */
  fileFormat: string;
  files: string[];
}

export interface SimilarFeatureOptions {
  startPath?: string;
  strictRoot?: boolean;
  query: string;
  limit?: number;
}

export interface WorkspaceIndexOptions {
  startPath?: string;
  rebuild?: boolean;
  maxFileBytes?: number;
}

export interface WorkspaceIndexEntry {
  repo: WorkspaceRepoDescriptor;
  result: IndexResult;
}

export interface WorkspaceIndexResult {
  workspace: WorkspaceServiceResult["workspace"];
  workspacePath: string;
  repoMapPath: string;
  repos: WorkspaceRepoDescriptor[];
  results: WorkspaceIndexEntry[];
}

export interface WorkspaceSearchOptions {
  startPath?: string;
  query: string;
  limit?: number;
}

export interface WorkspaceSearchResult extends SearchResult {
  repoName: string;
  repoRole?: string;
  repoRoot: string;
}

export interface WorkspaceSearchEntry {
  repo: WorkspaceRepoDescriptor;
  response: SearchResponse;
}

export interface WorkspaceSearchResponse {
  schemaVersion: string;
  generatedAt: string;
  query: string;
  workspace: WorkspaceServiceResult["workspace"];
  repos: WorkspaceRepoDescriptor[];
  results: WorkspaceSearchEntry[];
  combinedResults: WorkspaceSearchResult[];
}
