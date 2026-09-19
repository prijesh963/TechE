import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CheckpointDiff } from "@copilot-architect/session";

import { plannedPaths, type ChangeKind, type PlanContract } from "./plan-contract.js";

export interface ApplyChangeInput {
  relativePath: string;
  kind: ChangeKind;
  /** The new file contents. Required for add and update, ignored for delete. */
  afterText?: string;
}

export interface ApplyPlanOptions {
  workspaceRoot: string;
  changes: ApplyChangeInput[];
}

export interface RefusedChange {
  relativePath: string;
  reason: string;
}

export interface ApplyPlanResult {
  written: string[];
  deleted: string[];
  /**
   * Changes not applied, each with why. Refusing and reporting beats throwing:
   * one bad path should not abandon the rest half-applied, and a developer
   * needs to know exactly which changes did not land.
   */
  refused: RefusedChange[];
}

/**
 * Writes an approved plan's changes to disk.
 *
 * The only place in the product that modifies a developer's working tree, so
 * the guards live here rather than in whichever shell happened to call it.
 * Every path is resolved and checked to be inside the workspace root before
 * anything is written — a plan is data, and data that names `../../etc/passwd`
 * must not be able to reach outside the repo just because a model produced it.
 */
export async function applyPlanChanges(
  options: ApplyPlanOptions
): Promise<ApplyPlanResult> {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const result: ApplyPlanResult = { written: [], deleted: [], refused: [] };

  for (const change of options.changes) {
    const target = path.resolve(workspaceRoot, change.relativePath);

    if (!isInside(workspaceRoot, target)) {
      result.refused.push({
        relativePath: change.relativePath,
        reason: "resolves outside the workspace root"
      });
      continue;
    }

    if (change.kind === "delete") {
      try {
        await rm(target, { force: true });
        result.deleted.push(change.relativePath);
      } catch (error) {
        result.refused.push({
          relativePath: change.relativePath,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
      continue;
    }

    if (change.afterText === undefined) {
      // An update with no replacement is a gap in the plan, not an empty file.
      result.refused.push({
        relativePath: change.relativePath,
        reason: "no replacement content was produced"
      });
      continue;
    }

    try {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, change.afterText, "utf8");
      result.written.push(change.relativePath);
    } catch (error) {
      result.refused.push({
        relativePath: change.relativePath,
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return result;
}

export interface PlanComparison {
  /** Files the plan named that did change — the work landing as intended. */
  asPlanned: string[];
  /** Files the plan named that did not change. */
  untouched: string[];
  /**
   * Files that changed but the plan never mentioned. The finding that matters
   * most: scope creep used to pass silently because nothing compared the two.
   */
  unplanned: string[];
  deleted: string[];
}

/**
 * Classifies what actually changed against what the plan said would change.
 *
 * Both halves matter. A planned file that never changed may mean the work is
 * incomplete; an unplanned file that did change may be the riskiest thing in
 * the diff, and is exactly what a review reading only the plan would miss.
 */
export function compareAgainstPlan(
  plan: PlanContract,
  diff: CheckpointDiff
): PlanComparison {
  const planned = new Set(plannedPaths(plan));
  const changed = [...diff.added, ...diff.modified];

  return {
    asPlanned: changed.filter((file) => planned.has(file)).sort(),
    untouched: [...planned]
      .filter((file) => !changed.includes(file) && !diff.deleted.includes(file))
      .sort(),
    unplanned: changed.filter((file) => !planned.has(file)).sort(),
    deleted: [...diff.deleted].sort()
  };
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}
