#!/usr/bin/env node
/**
 * Captures a "before" snapshot of how much source content the planner's
 * relevant-file selection would require, compared to reading the whole
 * repo naively. This is the baseline referenced by architecture item #5
 * (token/context measurement harness) in
 * docs/CODEBASE_INTELLIGENCE_DESIGN.md — run once now, before the
 * symbol/dependency graph (#1) and everything downstream of it lands, so
 * later runs have something real to compare against.
 *
 * Usage: npm run build && node scripts/context-baseline.mjs
 */

import { readdir, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const samplesDir = path.join(rootDir, "samples");
const outputDir = path.join(rootDir, "docs", "benchmarks");

const CANONICAL_REQUEST = "Add invoice approval workflow";

const EXCLUDED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".copilot-architect",
  "target",
  "__pycache__",
  ".venv",
  "venv"
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".java",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs"
]);

// Roughly 4 characters per token — a standard order-of-magnitude estimator
// used only for a directional before/after comparison, not billing accuracy.
const CHARS_PER_TOKEN = 4;

async function main() {
  const { FeaturePlanningService } = await import(
    pathToFileURL(path.join(rootDir, "packages/planner/dist/index.js")).href
  );

  const sampleNames = (await readdir(samplesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const service = new FeaturePlanningService();
  const results = [];

  for (const sampleName of sampleNames) {
    const repoRoot = path.join(samplesDir, sampleName);

    try {
      const preview = await service.createPlanPreview({
        startPath: repoRoot,
        strictRoot: true,
        request: CANONICAL_REQUEST
      });

      const naive = await measureNaiveRepo(repoRoot);
      const relevant = await measureRelevantFiles(
        preview.repoRoot,
        preview.plan.relevantFiles
      );

      const naiveTokens = Math.round(naive.totalBytes / CHARS_PER_TOKEN);
      const relevantTokens = Math.round(relevant.totalBytes / CHARS_PER_TOKEN);
      const reductionPercent =
        naiveTokens > 0
          ? Math.round((1 - relevantTokens / naiveTokens) * 1000) / 10
          : 0;

      results.push({
        sample: sampleName,
        request: CANONICAL_REQUEST,
        naiveWholeRepo: {
          fileCount: naive.fileCount,
          totalBytes: naive.totalBytes,
          estimatedTokens: naiveTokens
        },
        currentToolSelection: {
          relevantFileCount: preview.plan.relevantFiles.length,
          likelyFilesToModifyCount: preview.plan.likelyFilesToModify.length,
          filesReadableOnDisk: relevant.fileCount,
          totalBytes: relevant.totalBytes,
          estimatedTokens: relevantTokens
        },
        estimatedTokenReductionPercent: reductionPercent
      });

      console.log(
        `${sampleName}: naive ~${naiveTokens} tokens (${naive.fileCount} files) -> ` +
          `selected ~${relevantTokens} tokens (${preview.plan.relevantFiles.length} files), ` +
          `~${reductionPercent}% smaller`
      );
    } catch (error) {
      console.warn(
        `Skipping ${sampleName}: ${error instanceof Error ? error.message : error}`
      );
    }
  }

  const snapshot = {
    schemaVersion: "1",
    capturedAt: new Date().toISOString(),
    methodology: {
      description:
        "For each sample repo, runs FeaturePlanningService.createPlanPreview() with a " +
        "canonical feature request (no artifacts written to the sample repo) and " +
        "compares the byte size of the files it flags as relevant against the byte " +
        "size of the whole repo's source files. Token counts are a rough " +
        `chars/${CHARS_PER_TOKEN} estimate, not a real tokenizer — this snapshot is a ` +
        "directional 'before' baseline for architecture item #5, not a billing " +
        "measurement. It predates the symbol/dependency graph (item #1) and everything " +
        "downstream of it (hybrid retrieval, intent classification, graph-based " +
        "citations); re-run this script after those land to compare.",
      canonicalRequest: CANONICAL_REQUEST,
      charsPerTokenEstimate: CHARS_PER_TOKEN
    },
    samples: results
  };

  await mkdir(outputDir, { recursive: true });
  const snapshotPath = path.join(outputDir, "baseline-context-snapshot.json");
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${path.relative(rootDir, snapshotPath)}`);
}

async function measureNaiveRepo(repoRoot) {
  let fileCount = 0;
  let totalBytes = 0;

  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (EXCLUDED_DIR_NAMES.has(entry.name)) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        continue;
      }

      const stats = await stat(fullPath);
      fileCount += 1;
      totalBytes += stats.size;
    }
  }

  await walk(repoRoot);
  return { fileCount, totalBytes };
}

async function measureRelevantFiles(repoRoot, relevantFiles) {
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
