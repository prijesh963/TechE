import { IndexingService, type SearchResult } from "@copilot-architect/indexer";
import { CURRENT_SCHEMA_VERSION } from "@copilot-architect/shared";

import { classifyIntent, extractEntities } from "./intent-classifier.js";
import type {
  QueryIntentOptions,
  QueryIntentResult,
  RelevantFileSummary
} from "./models.js";

const DEFAULT_CATEGORY_LIMIT = 8;
const RELEVANT_TESTS_LIMIT = 5;
const RECENT_CHANGES_LIMIT = 5;
// Search wider than any single category needs so partitioning into
// components/tests/recency still has enough candidates to draw from.
const SEARCH_WIDTH_MULTIPLIER = 3;

export class QueryIntentService {
  /**
   * Classifies a natural-language query's intent, extracts its subject
   * entities, and resolves likely components/relevant tests/recent
   * changes by calling the existing hybrid search (packages/indexer) —
   * this does not reimplement retrieval, it classifies and reshapes what
   * #2 already returns. See docs/CODEBASE_INTELLIGENCE_DESIGN.md section 3.
   */
  async analyze(options: QueryIntentOptions): Promise<QueryIntentResult> {
    const query = options.query.trim();

    if (!query) {
      throw new Error("query is required");
    }

    const intent = classifyIntent(query);
    const entities = extractEntities(query);
    const refinedQuery = entities.length > 0 ? entities.join(" ") : query;
    const categoryLimit = options.limit ?? DEFAULT_CATEGORY_LIMIT;

    const response = await new IndexingService().search({
      startPath: options.startPath,
      strictRoot: options.strictRoot,
      query: refinedQuery,
      limit: categoryLimit * SEARCH_WIDTH_MULTIPLIER
    });

    const likelyComponents = response.results
      .filter((result) => !result.isTestFile)
      .slice(0, categoryLimit)
      .map((result) => summarize(result, entities));
    const relevantTests = response.results
      .filter((result) => result.isTestFile)
      .slice(0, RELEVANT_TESTS_LIMIT)
      .map((result) => summarize(result, entities));
    const recentChanges = response.results
      .filter((result) => result.signals.includes("recency"))
      .slice(0, RECENT_CHANGES_LIMIT)
      .map((result) => summarize(result, entities));

    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      repoRoot: response.repoRoot,
      query,
      intent,
      entities,
      refinedQuery,
      likelyComponents,
      relevantTests,
      recentChanges
    };
  }
}

function summarize(result: SearchResult, entities: string[]): RelevantFileSummary {
  return {
    filePath: result.relativePath,
    reason: describeReason(result, entities),
    score: result.score,
    signals: result.signals,
    anchor: result.anchor
  };
}

function describeReason(result: SearchResult, entities: string[]): string {
  const parts: string[] = [];

  if (result.signals.includes("lexical") || result.signals.includes("structural")) {
    const matchedEntities = entities.filter(
      (entity) =>
        result.relativePath.toLowerCase().includes(entity) ||
        result.symbols.some((symbol) => symbol.name.toLowerCase().includes(entity))
    );
    parts.push(
      matchedEntities.length > 0
        ? `matches entity term(s) ${matchedEntities.join(", ")}`
        : "keyword match"
    );
  }

  if (result.signals.includes("graph")) {
    parts.push("connected via the symbol/dependency graph to a top match");
  }

  if (result.signals.includes("recency")) {
    parts.push("recently/frequently changed");
  }

  return parts.length > 0 ? parts.join("; ") : "matched search index";
}
