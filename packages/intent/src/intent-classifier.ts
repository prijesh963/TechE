import type { QueryIntentLabel } from "./models.js";

// Order matters: checked in this precedence, most operationally clear
// first. A query matching multiple categories (rare) resolves to
// whichever is clearer to act on — "why is X broken, should I refactor
// it" is a debugging query first.
const DEBUG_PATTERN =
  /\b(why|debug(?:ging)?|bugs?|errors?|fail(?:s|ing|ed|ure)?|broken|break(?:s|ing)?|crash(?:es|ing|ed)?|exceptions?|regressions?|incorrect|wrong|not\s+working)\b/i;
const REFACTOR_PATTERN =
  /\b(refactor(?:ing)?|clean\s*up|reorgani[sz]e|restructure|simplify|rename|extract|de-?dupe|de-?duplicate)\b/i;
const TEST_PATTERN = /\b(tests?|coverage|specs?|unit\s+test|integration\s+test)\b/i;
const FEATURE_PATTERN =
  /\b(add|implement|create|build|support|introduce|enhance|new\s+feature)\b/i;

export function classifyIntent(query: string): QueryIntentLabel {
  if (DEBUG_PATTERN.test(query)) return "debugging";
  if (REFACTOR_PATTERN.test(query)) return "refactor";
  if (TEST_PATTERN.test(query)) return "test";
  if (FEATURE_PATTERN.test(query)) return "feature";
  return "unknown";
}

// Common English filler plus every intent-trigger word above — the point
// of extraction is to remove exactly the words that dilute BM25 matching
// against file content that never contains "why" or "is" meaningfully.
// Intent-trigger words describe the *action* (already captured by
// `intent`), not the *subject*, so including them here would just
// re-inject the noise this step is meant to remove.
const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "to",
  "for",
  "of",
  "in",
  "on",
  "at",
  "by",
  "with",
  "and",
  "or",
  "not",
  "why",
  "how",
  "what",
  "when",
  "where",
  "which",
  "who",
  "whom",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "do",
  "does",
  "did",
  "doesn't",
  "don't",
  "didn't",
  "i",
  "we",
  "you",
  "they",
  "he",
  "she",
  "please",
  "can",
  "could",
  "should",
  "would",
  "want",
  "need",
  "my",
  "our",
  "your",
  // Intent-trigger words (see classifyIntent's patterns above).
  "debug",
  "debugging",
  "bug",
  "bugs",
  "error",
  "errors",
  "fail",
  "fails",
  "failing",
  "failed",
  "failure",
  "broken",
  "break",
  "breaks",
  "breaking",
  "crash",
  "crashes",
  "crashing",
  "crashed",
  "exception",
  "exceptions",
  "regression",
  "regressions",
  "incorrect",
  "wrong",
  "working",
  "refactor",
  "refactoring",
  "cleanup",
  "reorganize",
  "reorganise",
  "restructure",
  "simplify",
  "rename",
  "extract",
  "dedupe",
  "deduplicate",
  "test",
  "tests",
  "testing",
  "coverage",
  "spec",
  "specs",
  "add",
  "implement",
  "create",
  "build",
  "support",
  "introduce",
  "enhance",
  "new",
  "feature"
]);

const DEFAULT_MAX_ENTITIES = 8;

/**
 * Extracts the significant subject terms from a query, dropping common
 * English filler and intent-trigger verbs. Order-preserving, deduped.
 * A regex/stopword heuristic, not NLP — consistent with every other
 * classification in this codebase (createRisks's security/migration
 * signal regexes, AdvancedAnalysisService's pattern detectors).
 */
export function extractEntities(
  query: string,
  maxEntities = DEFAULT_MAX_ENTITIES
): string[] {
  const seen = new Set<string>();
  const entities: string[] = [];

  for (const rawWord of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!rawWord || rawWord.length < 3 || STOPWORDS.has(rawWord) || seen.has(rawWord)) {
      continue;
    }
    seen.add(rawWord);
    entities.push(rawWord);
    if (entities.length >= maxEntities) break;
  }

  return entities;
}
