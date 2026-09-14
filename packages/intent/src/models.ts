import type { SearchAnchor, SearchSignal } from "@copilot-architect/indexer";
import type { GeneratedArtifact } from "@copilot-architect/shared";

export type QueryIntentLabel =
  | "debugging"
  | "feature"
  | "refactor"
  | "test"
  | "unknown";

export interface QueryIntentOptions {
  startPath?: string;
  strictRoot?: boolean;
  query: string;
  /** Max entries per category. Defaults to 8. */
  limit?: number;
}

export interface RelevantFileSummary {
  filePath: string;
  /** Synthesized from which SearchResult.signals fired for this file. */
  reason: string;
  score: number;
  signals: SearchSignal[];
  anchor?: SearchAnchor;
}

export interface QueryIntentResult extends GeneratedArtifact {
  repoRoot: string;
  query: string;
  intent: QueryIntentLabel;
  entities: string[];
  /** The query actually sent to search — entity terms when extraction
   *  found any, otherwise the original query unchanged. */
  refinedQuery: string;
  /** Non-test results. */
  likelyComponents: RelevantFileSummary[];
  /** isTestFile results. */
  relevantTests: RelevantFileSummary[];
  /** Results whose signals include "recency" — categories can and do
   *  overlap with the two above. */
  recentChanges: RelevantFileSummary[];
}
