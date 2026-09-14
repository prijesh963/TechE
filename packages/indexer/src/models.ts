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
