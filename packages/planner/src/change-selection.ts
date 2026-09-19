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

import type { ChangeKind, PlannedExport, PlannedOutline } from "./plan-contract.js";

export interface SelectedChange {
  kind: ChangeKind;
  relativePath: string;
  /** Why this file changes, in the model's words. */
  rationale: string;
  /**
   * A symbol the rationale rests on, which the file must actually declare.
   *
   * The rationale itself is prose and cannot be checked — "holds the invoice
   * lifecycle this hooks into" is either true or a confident fabrication, and
   * nothing local can tell them apart. Asking for one symbol alongside it
   * makes a checkable claim out of an uncheckable one: if the file does not
   * declare what the reason is built on, the reason is about some other file.
   */
  evidenceSymbol?: string;
}

export type EvidenceStatus = "verified" | "unverified" | "not-checked";

export interface VerifiedChange extends SelectedChange {
  evidence: EvidenceStatus;
  /** Why it did not verify, in terms a developer can act on. */
  evidenceReason?: string;
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

    // kind | path | why | symbol the reason rests on
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

    const evidenceSymbol = normalizeEvidenceSymbol(parts[3]);

    seen.add(relativePath);
    selected.push({
      kind: kind === "add" && exists ? "update" : kind,
      relativePath,
      rationale,
      ...(evidenceSymbol ? { evidenceSymbol } : {})
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

/**
 * Checks each selection's cited symbol against the file it names.
 *
 * Nothing is dropped. A rationale that does not verify is still a file the
 * model judged necessary, and the developer decides — the plan is the
 * reviewable artifact, and removing a row from it silently would be a worse
 * failure than showing one with a warning.
 *
 * Only `update` and `delete` are checkable. An `add` names a file that does
 * not exist yet, so there is nothing to verify against and it is reported as
 * unchecked rather than guessed at.
 */
export function verifySelectedChanges(
  selection: SelectedChange[],
  symbolsByFile: Map<string, Set<string>>
): VerifiedChange[] {
  return selection.map((change) => {
    if (change.kind === "add") {
      return {
        ...change,
        evidence: "not-checked" as const,
        evidenceReason: "a new file has nothing to check against"
      };
    }

    if (!change.evidenceSymbol) {
      return {
        ...change,
        evidence: "not-checked" as const,
        evidenceReason: "no symbol was cited"
      };
    }

    const symbols = symbolsByFile.get(change.relativePath);

    // A file with no indexed symbols is not a file whose symbols are absent —
    // plenty of real files declare none the indexer recognizes.
    if (!symbols || symbols.size === 0) {
      return {
        ...change,
        evidence: "not-checked" as const,
        evidenceReason: "no symbols are indexed for this file"
      };
    }

    return symbols.has(change.evidenceSymbol)
      ? { ...change, evidence: "verified" as const }
      : {
          ...change,
          evidence: "unverified" as const,
          evidenceReason: `\`${change.evidenceSymbol}\` is not declared in this file`
        };
  });
}

/**
 * A bare identifier, or `undefined`.
 *
 * Deliberately narrow: `OrderService` and `OrderService.place` are claims that
 * can be looked up, and anything else — a phrase, a sentence, a path — is the
 * model narrating, which would verify against nothing and report every row as
 * unconfirmed.
 */
function normalizeEvidenceSymbol(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const cleaned = value.replace(/^`|`$/g, "").replace(/\(\)$/, "").trim();
  // Qualified form: the type is what the index records as a symbol.
  const bare = cleaned.includes(".") ? cleaned.split(".")[0] : cleaned;

  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(bare) && bare.length <= 120
    ? bare
    : undefined;
}

/** More exports than this from one new file is a module, not a file. */
const MAX_OUTLINE_EXPORTS = 12;

/** A file this long is not something a developer can review from a sentence. */
const MAX_ESTIMATED_LINES = 2000;

export interface ParseOutlinesOptions {
  /** The `add` paths this plan proposes. An outline for anything else is noise. */
  addPaths: Set<string>;
  /**
   * Every path the index knows. An outline's imports are checked against it:
   * an import of a file that is not there means the outline was written about
   * a different repository.
   */
  indexedPaths: Set<string>;
}

/**
 * Reads outlines for the new files a plan proposes.
 *
 * An outline is what an `add` has instead of a `before` snapshot. It exists so
 * the developer approves something concrete — what the file will export, what
 * it will import, roughly how big it will be — rather than a sentence that
 * could mean anything.
 *
 * Returned as a map because an outline that names no known `add` has nothing
 * to attach to, and is dropped rather than creating a change the selection
 * never chose.
 */
export function parseAddOutlines(
  text: string,
  options: ParseOutlinesOptions
): Map<string, PlannedOutline> {
  const files = new Map<string, { dependsOn: string[]; estimatedLines?: number }>();
  const exportsByPath = new Map<string, PlannedExport[]>();

  for (const line of text.split("\n")) {
    const trimmed = line.trim().replace(/^[-*]\s*/, "");
    if (!trimmed) continue;

    const parts = trimmed.split("|").map((part) => part.trim());
    const record = parts[0].toLowerCase();

    // Two record kinds rather than one wide line: a signature contains commas
    // and parentheses, so packing exports into a comma-separated field would
    // make every signature unparseable.
    if (record === "file") {
      readFileRecord(parts, options, files);
    } else if (record === "export") {
      readExportRecord(parts, options, exportsByPath);
    }
  }

  const outlines = new Map<string, PlannedOutline>();

  for (const [relativePath, exports] of exportsByPath) {
    // An outline with nothing in it bounds nothing, and showing it would
    // imply the add had been thought about when it had not. A file record on
    // its own is exactly that.
    if (exports.length === 0) continue;

    const file = files.get(relativePath);
    outlines.set(relativePath, {
      exports,
      dependsOn: file?.dependsOn ?? [],
      ...(file?.estimatedLines !== undefined
        ? { estimatedLines: file.estimatedLines }
        : {})
    });
  }

  return outlines;
}

/** `file | path | imports | rough line count` */
function readFileRecord(
  parts: string[],
  options: ParseOutlinesOptions,
  files: Map<string, { dependsOn: string[]; estimatedLines?: number }>
): void {
  const relativePath = normalizeSelectedPath(parts[1] ?? "");
  if (!relativePath || !options.addPaths.has(relativePath)) return;
  if (files.has(relativePath)) return;

  // Imports are kept only where the file exists. A dependency on something
  // that is not there is the outline describing a different repository, and
  // showing it would put a false fact in front of the developer.
  const dependsOn = splitList(parts[2])
    .map((value) => normalizeSelectedPath(value))
    .filter((value): value is string => value !== undefined)
    .filter((value) => options.indexedPaths.has(value));

  const estimatedLines = parseEstimatedLines(parts[3]);

  files.set(relativePath, {
    dependsOn,
    ...(estimatedLines !== undefined ? { estimatedLines } : {})
  });
}

/** `export | path | name | signature | purpose` */
function readExportRecord(
  parts: string[],
  options: ParseOutlinesOptions,
  exportsByPath: Map<string, PlannedExport[]>
): void {
  const relativePath = normalizeSelectedPath(parts[1] ?? "");
  if (!relativePath || !options.addPaths.has(relativePath)) return;

  const name = normalizeExportName(parts[2] ?? "");
  if (!name) return;

  const existing = exportsByPath.get(relativePath) ?? [];
  if (existing.length >= MAX_OUTLINE_EXPORTS) return;
  if (existing.some((entry) => entry.name === name)) return;

  existing.push({
    name,
    ...(describable(parts[3]) ? { signature: parts[3] } : {}),
    ...(describable(parts[4]) ? { purpose: parts[4] } : {})
  });
  exportsByPath.set(relativePath, existing);
}

/**
 * Whether a free-text field says anything.
 *
 * A one-character field is a placeholder the model left behind, and a very
 * long one is prose that will not fit on the line the plan shows.
 */
function describable(value: string | undefined): value is string {
  return value !== undefined && value.length > 2 && value.length <= 200;
}

/** Lines for the plan, or `undefined` when there is nothing to say. */
export function renderOutline(outline: PlannedOutline | undefined): string | undefined {
  if (!outline) return undefined;

  const header: string[] = [];

  if (outline.dependsOn.length > 0) {
    header.push(`imports ${outline.dependsOn.join(", ")}`);
  }

  if (outline.estimatedLines !== undefined) {
    header.push(`~${outline.estimatedLines} lines`);
  }

  // Each export on its own line: a signature and a purpose do not fit
  // readably in a comma-separated run, and cramming them there is how a
  // developer ends up skimming past the thing they were meant to approve.
  const rows = outline.exports.map((entry) => {
    const called = entry.signature ? ` \`${entry.signature}\`` : "";
    const why = entry.purpose ? ` — ${entry.purpose}` : "";
    return `    · **${entry.name}**${called}${why}`;
  });

  return [
    header.length > 0
      ? `will export ${outline.exports.length}, ${header.join(" · ")}`
      : `will export ${outline.exports.length}`,
    ...rows
  ].join("\n");
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeExportName(value: string): string | undefined {
  const cleaned = value.replace(/^`|`$/g, "").replace(/\(\)$/, "").trim();

  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(cleaned) && cleaned.length <= 120
    ? cleaned
    : undefined;
}

function parseEstimatedLines(value: string | undefined): number | undefined {
  const digits = /(\d+)/.exec(value ?? "");
  if (!digits) return undefined;

  const lines = Number(digits[1]);
  return Number.isInteger(lines) && lines > 0 && lines <= MAX_ESTIMATED_LINES
    ? lines
    : undefined;
}
