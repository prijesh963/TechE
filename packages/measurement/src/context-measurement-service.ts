import { stat } from "node:fs/promises";
import path from "node:path";

import {
  FeaturePlanningService,
  type PlanFileReference
} from "@copilot-architect/planner";
import {
  CURRENT_SCHEMA_VERSION,
  isBinaryPath,
  scanRepository
} from "@copilot-architect/shared";

import type { ContextMeasurement, ContextMeasurementOptions } from "./models.js";

// Roughly 4 characters per token — a standard order-of-magnitude estimator
// used only for a directional before/after comparison, not billing accuracy.
const CHARS_PER_TOKEN = 4;

export class ContextMeasurementService {
  /**
   * Compares the context cost of naively sending a whole repo against the
   * cost of only the files FeaturePlanningService flags as relevant for a
   * request. See docs/CODEBASE_INTELLIGENCE_DESIGN.md section 5. Not
   * persisted as a `.copilot-architect/` artifact — a point-in-time answer
   * to one request, not repo state.
   */
  async measure(options: ContextMeasurementOptions): Promise<ContextMeasurement> {
    const request = options.request.trim();

    if (!request) {
      throw new Error("request is required");
    }

    const preview = await new FeaturePlanningService().createPlanPreview({
      startPath: options.startPath,
      strictRoot: options.strictRoot,
      request
    });

    const naive = await measureNaiveRepo(preview.repoRoot);
    const selected = await measureRelevantFiles(
      preview.repoRoot,
      preview.plan.relevantFiles
    );

    const naiveTokens = estimateTokens(naive.totalBytes);
    const selectedTokens = estimateTokens(selected.totalBytes);
    const estimatedTokenReductionPercent =
      naiveTokens > 0 ? Math.round((1 - selectedTokens / naiveTokens) * 1000) / 10 : 0;

    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      repoRoot: preview.repoRoot,
      request,
      naiveWholeRepo: {
        fileCount: naive.fileCount,
        totalBytes: naive.totalBytes,
        estimatedTokens: naiveTokens
      },
      currentToolSelection: {
        relevantFileCount: preview.plan.relevantFiles.length,
        likelyFilesToModifyCount: preview.plan.likelyFilesToModify.length,
        filesReadableOnDisk: selected.fileCount,
        totalBytes: selected.totalBytes,
        estimatedTokens: selectedTokens
      },
      estimatedTokenReductionPercent
    };
  }
}

function estimateTokens(totalBytes: number): number {
  return Math.round(totalBytes / CHARS_PER_TOKEN);
}

async function measureNaiveRepo(
  repoRoot: string
): Promise<{ fileCount: number; totalBytes: number }> {
  const entries = await scanRepository(repoRoot);
  let fileCount = 0;
  let totalBytes = 0;

  for (const entry of entries) {
    if (isBinaryPath(entry.relativePath)) continue;
    fileCount += 1;
    totalBytes += entry.sizeBytes;
  }

  return { fileCount, totalBytes };
}

async function measureRelevantFiles(
  repoRoot: string,
  relevantFiles: PlanFileReference[]
): Promise<{ fileCount: number; totalBytes: number }> {
  let fileCount = 0;
  let totalBytes = 0;

  for (const file of relevantFiles) {
    try {
      const stats = await stat(path.join(repoRoot, file.filePath));
      fileCount += 1;
      totalBytes += stats.size;
    } catch {
      // Referenced path didn't resolve to a readable file — skip it.
    }
  }

  return { fileCount, totalBytes };
}
