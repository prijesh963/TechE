/**
 * Choosing which files a plan should change, and how.
 *
 * Search relevance answers "what is related to this request". A plan needs
 * "what has to change", which is a different question: a test that mentions
 * the term, a README describing the feature and a barrel file re-exporting it
 * all rank highly and need no edit. Before this, every search hit became an
 * `update`, so plans named plausible files rather than correct ones — and
 * nothing could ever propose a file that did not exist yet, which is most of
 * what a feature actually needs.
 *
 * So retrieval proposes candidates and the model selects from them. This
 * module validates that selection, and its rules are the load-bearing part:
 * a plan is data that later authorizes writing code, so a path in it must be
 * one that can be checked, not one a model produced unsupervised.
 */

import path from "node:path";

import type { ChangeKind } from "./plan-contract.js";

export interface SelectedChange {
  kind: ChangeKind;
  relativePath: string;
  /** Why this file changes, in the model's words. */
  rationale: string;
}

export interface SelectChangesOptions {
  /** Repo-relative paths the search offered, in rank order. */
  candidates: string[];
  /**
   * Every path the index knows about. An `update` or `delete` must name one:
   * a path outside it was invented, and the plan would quote a snapshot of a
   * file that is not there.
   */
  indexedPaths: Set<string>;
  /** A plan touching more files than this is not a plan. */
  maxChanges?: number;
}

export const DEFAULT_MAX_CHANGES = 12;

const CHANGE_KINDS: ChangeKind[] = ["add", "update", "delete"];

/**
 * Reads a file selection out of a model response.
 *
 * Every rule here exists because the alternative is worse than dropping the
 * line:
 *
 * - An `update` or `delete` naming a path the index does not have is a
 *   hallucination. Kept, it would produce a change with no snapshot, and
 *   implementation would patch a file nobody has read.
 * - An `add` naming a path that already exists is not an add. The intent is
 *   unambiguous, so it becomes an `update` rather than being dropped — which
 *   would silently lose a file the model judged necessary.
 * - A path that escapes the repo root is refused here, not at write time.
 *   `applyPlanChanges` guards the write, but a developer should never be
 *   shown a plan that proposes writing outside their repository.
 */
export function parseSelectedChanges(
  text: string,
  options: SelectChangesOptions
): SelectedChange[] {
  const max = options.maxChanges ?? DEFAULT_MAX_CHANGES;
  const selected: SelectedChange[] = [];
  const seen = new Set<string>();

  for (const line of text.split("\n")) {
    const trimmed = line.trim().replace(/^[-*]\s*/, "");
    if (!trimmed) continue;

    // kind | path | why
    const parts = trimmed.split("|").map((part) => part.trim());
    if (parts.length < 3) continue;

    const kind = parts[0].toLowerCase() as ChangeKind;
    if (!CHANGE_KINDS.includes(kind)) continue;

    const relativePath = normalizeSelectedPath(parts[1]);
    if (!relativePath) continue;

    const rationale = parts[2];
    // "needed" is not a reason. A rationale a reviewer cannot weigh is noise
    // in the artifact this design exists to produce.
    if (rationale.length < 8 || rationale.length > 400) continue;

    if (seen.has(relativePath)) continue;

    const exists = options.indexedPaths.has(relativePath);

    if (kind !== "add" && !exists) {
      continue;
    }

    seen.add(relativePath);
    selected.push({
      kind: kind === "add" && exists ? "update" : kind,
      relativePath,
      rationale
    });

    if (selected.length === max) break;
  }

  return selected;
}

/**
 * The fallback when no model is available, or when nothing it said survived
 * validation.
 *
 * The old behaviour, kept deliberately: the top candidates as updates. It is
 * a worse plan, and the caller says so rather than presenting it as a
 * considered selection.
 */
export function selectByRelevance(
  candidates: string[],
  signalsFor: (relativePath: string) => string[],
  limit = 8
): SelectedChange[] {
  return candidates.slice(0, limit).map((relativePath) => ({
    kind: "update" as ChangeKind,
    relativePath,
    rationale: `Matched on ${signalsFor(relativePath).join(", ") || "keyword relevance"}`
  }));
}

/**
 * A repo-relative path, or `undefined` when it is not one.
 *
 * Rejects absolute paths and anything that climbs out of the root. Backslashes
 * are normalized because a model shown POSIX paths still sometimes answers in
 * Windows ones.
 */
function normalizeSelectedPath(value: string): string | undefined {
  const cleaned = value.replace(/^`|`$/g, "").replace(/\\/g, "/").trim();

  if (!cleaned || cleaned.length > 400) return undefined;
  if (path.posix.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) return undefined;

  const normalized = path.posix.normalize(cleaned);
  if (normalized.startsWith("..") || normalized === ".") return undefined;

  return normalized;
}
