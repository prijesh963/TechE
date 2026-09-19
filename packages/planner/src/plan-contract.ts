import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Decision } from "@copilot-architect/session";
import {
  CURRENT_SCHEMA_VERSION,
  createTrustMetadata,
  getArtifactDirectoryPath,
  type GeneratedArtifact
} from "@copilot-architect/shared";

/**
 * An implementation contract: everything `/implement` needs, so it never has to
 * read the repository again.
 *
 * This is the idea the product rests on. Retrieval happens once, during
 * planning, and this artifact is its durable output. If a later phase re-read
 * the repo, the work would be paid for twice and the tool would be no better
 * than using Copilot directly.
 *
 * It follows that the plan carries the real code being changed, not a pointer
 * to it — and that the code is **extracted by this module**, never written by a
 * model. A model asked to reproduce existing code paraphrases it; a paraphrase
 * applied as a patch corrupts the file. Copying is also cheaper than paying a
 * model to retype what is already on disk.
 */
export interface PlanContract extends GeneratedArtifact {
  /** What the developer asked for, in their words. */
  request: string;
  version: number;
  /**
   * The session decisions this plan was built under, snapshotted at draft time.
   * Embedded rather than referenced so the plan can be read, reviewed and
   * defended on its own — including by someone without the session.
   */
  decisions: Decision[];
  changes: PlannedChange[];
  validation: PlanCommand[];
  /** Anything the plan depends on that is not a file — contracts, conventions. */
  notes: string[];
}

export interface PlannedChange {
  kind: ChangeKind;
  /** Set only in a multi-repo workspace; `relativePath` is relative to it. */
  repoName?: string;
  relativePath: string;
  /** Why this change, in the plan's own words. Model-written, and fine to be. */
  rationale: string;
  /**
   * The code as it stood when the plan was built. Absent for an `add`, since
   * there is nothing to quote.
   */
  before?: CodeExcerpt;
  /**
   * Content hash of the whole file at plan time, so implementation can tell
   * cheaply whether the file moved underneath it — a verification, not a
   * re-read, so it does not break the retrieve-once rule.
   */
  beforeHash?: string;
  /**
   * What a new file will contain. Set only on an `add`, where there is no
   * `before` to quote.
   *
   * Without it, an `add` is approved from a sentence: "new rules deciding who
   * may approve" could be forty lines or eight hundred, exporting anything.
   * An update shows the developer real code before they approve; this is the
   * nearest equivalent for a file that does not exist yet.
   */
  outline?: PlannedOutline;
}

export interface PlannedOutline {
  /** Symbols the new file will declare. */
  exports: string[];
  /**
   * Existing repo files it will import. Verified to exist when the outline is
   * parsed — an import of a file that is not there is a checkable claim, and
   * a wrong one means the outline was written about a different repository.
   */
  dependsOn: string[];
  /** Rough size, so a one-line rationale cannot quietly mean a large file. */
  estimatedLines?: number;
}

export type ChangeKind = "add" | "update" | "delete";

/**
 * A window of real file content. `fileLines` is carried so a reader can see
 * this is an excerpt rather than the whole file, instead of assuming.
 */
export interface CodeExcerpt {
  startLine: number;
  endLine: number;
  fileLines: number;
  text: string;
}

export interface PlanCommand {
  command: string;
  /** The repo it must run in — a build command run at the wrong root fails. */
  cwd?: string;
}

export interface BuildChangeOptions {
  repoRoot: string;
  relativePath: string;
  kind: ChangeKind;
  rationale: string;
  repoName?: string;
  /**
   * Line to centre the excerpt on — the symbol anchor the index already
   * resolved. Without one the excerpt starts at the top of the file.
   */
  anchorLine?: number;
  /** Lines of context either side of the anchor. Defaults to 30. */
  contextLines?: number;
  /** What a new file will contain. Ignored for anything but an `add`. */
  outline?: PlannedOutline;
}

const DEFAULT_CONTEXT_LINES = 30;

/**
 * Builds one planned change, reading the current file from disk.
 *
 * There is deliberately no way to supply `before` text through this API. The
 * only path to a before-snippet is this function reading the file, which is
 * what makes "the model never writes the before code" a property of the code
 * rather than an instruction someone has to follow.
 */
export async function buildPlannedChange(
  options: BuildChangeOptions
): Promise<PlannedChange> {
  const base: PlannedChange = {
    kind: options.kind,
    ...(options.repoName ? { repoName: options.repoName } : {}),
    relativePath: options.relativePath,
    rationale: options.rationale.trim()
  };

  if (options.kind === "add") {
    return options.outline ? { ...base, outline: options.outline } : base;
  }

  let text: string;
  try {
    text = await readFile(path.join(options.repoRoot, options.relativePath), "utf8");
  } catch {
    // A plan that quotes a file which is not there is worse than one that
    // admits it could not read it. Implementation will fail the freshness
    // check rather than patch blind.
    return base;
  }

  return {
    ...base,
    before: extractExcerpt(
      text,
      options.anchorLine,
      options.contextLines ?? DEFAULT_CONTEXT_LINES
    ),
    beforeHash: hashContent(text)
  };
}

/**
 * A window of `text` centred on `anchorLine`, clamped to the file.
 *
 * Whole files would make a plan that touches twenty files into the expensive
 * prompt this design exists to avoid; a bare file path would make the plan
 * useless without re-reading the repo. A line-precise window is the middle, and
 * it is exactly what the index's symbol anchors were built to provide.
 */
export function extractExcerpt(
  text: string,
  anchorLine?: number,
  contextLines = DEFAULT_CONTEXT_LINES
): CodeExcerpt {
  const lines = text.split("\n");
  const anchor = anchorLine && anchorLine > 0 ? anchorLine : 1;
  const start = Math.max(1, anchor - contextLines);
  const end = Math.min(lines.length, anchor + contextLines);

  return {
    startLine: start,
    endLine: end,
    fileLines: lines.length,
    text: lines.slice(start - 1, end).join("\n")
  };
}

export interface PlanFreshness {
  /** Files whose content changed since the plan quoted them. */
  drifted: string[];
  /** Files the plan expects to modify that are no longer present. */
  missing: string[];
  /** True when implementation can proceed without re-planning. */
  ok: boolean;
}

/**
 * Checks the plan's file hashes against what is on disk now.
 *
 * Cheap and read-only: hashing the files a plan already names is not the same
 * as searching the repo again. Same-day work keeps drift small but not zero,
 * and applying a patch to a file that moved underneath it corrupts the file
 * silently — which is the failure mode worth spending a hash on.
 */
export async function verifyPlanFreshness(
  plan: PlanContract,
  repoRoot: string
): Promise<PlanFreshness> {
  const drifted: string[] = [];
  const missing: string[] = [];

  for (const change of plan.changes) {
    if (!change.beforeHash) continue;

    try {
      const text = await readFile(path.join(repoRoot, change.relativePath), "utf8");
      if (hashContent(text) !== change.beforeHash) {
        drifted.push(change.relativePath);
      }
    } catch {
      missing.push(change.relativePath);
    }
  }

  return {
    drifted: drifted.sort(),
    missing: missing.sort(),
    ok: drifted.length === 0 && missing.length === 0
  };
}

export interface CreatePlanContractOptions {
  request: string;
  version: number;
  decisions: Decision[];
  changes: PlannedChange[];
  validation?: PlanCommand[];
  notes?: string[];
}

export function createPlanContract(options: CreatePlanContractOptions): PlanContract {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    trust: createTrustMetadata({
      artifactKind: "plan-contract",
      source: "PlanContract"
    }),
    request: options.request.trim(),
    version: options.version,
    decisions: options.decisions,
    changes: options.changes,
    validation: options.validation ?? [],
    notes: options.notes ?? []
  };
}

export interface WriteApprovedPlanResult {
  planPath: string;
  latestPath: string;
}

/**
 * Writes an approved plan to `.copilot-architect/plans/approved/`.
 *
 * Only ever called on approval. A draft lives in the session and nowhere else,
 * so nothing downstream can mistake work-in-progress for an authorized plan —
 * which reverses the previous order, where a plan was written first and marked
 * approved afterwards.
 */
export async function writeApprovedPlan(
  workspaceRoot: string,
  plan: PlanContract
): Promise<WriteApprovedPlanResult> {
  const directory = path.join(
    getArtifactDirectoryPath(workspaceRoot, "plans"),
    "approved"
  );
  await mkdir(directory, { recursive: true });

  const body = `${JSON.stringify(plan, null, 2)}\n`;
  const planPath = path.join(directory, `v${plan.version}.json`);
  const latestPath = path.join(directory, "latest.json");

  await writeFile(planPath, body, "utf8");
  // Versions are kept so a review round can be compared against the one before
  // it; `latest.json` saves every reader from working out which that is.
  await writeFile(latestPath, body, "utf8");

  return { planPath, latestPath };
}

export async function readApprovedPlan(
  workspaceRoot: string,
  version?: number
): Promise<PlanContract | undefined> {
  const directory = path.join(
    getArtifactDirectoryPath(workspaceRoot, "plans"),
    "approved"
  );
  const file = version === undefined ? "latest.json" : `v${version}.json`;

  try {
    return JSON.parse(
      await readFile(path.join(directory, file), "utf8")
    ) as PlanContract;
  } catch {
    return undefined;
  }
}

/** Every path a plan intends to touch — what constraint checking is run over. */
export function plannedPaths(plan: PlanContract): string[] {
  return plan.changes
    .map((change) =>
      change.repoName
        ? `${change.repoName}/${change.relativePath}`
        : change.relativePath
    )
    .sort();
}

function hashContent(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
