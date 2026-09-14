#!/usr/bin/env node
/**
 * Re-runs the context-measurement harness (packages/measurement, item #5
 * in docs/CODEBASE_INTELLIGENCE_DESIGN.md) against the same sample matrix
 * and canonical request as scripts/context-baseline.mjs, and diffs the
 * result against the checked-in "before" snapshot
 * (docs/benchmarks/baseline-context-snapshot.json). This is the "after"
 * half of the item #5 measurement: does the symbol/dependency graph (#1),
 * hybrid retrieval (#2), query/intent classification (#3), and
 * graph-grounded citations (#4) actually change how much context a plan
 * selects, or not?
 *
 * Usage: npm run build && node scripts/context-measure-samples.mjs
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const samplesDir = path.join(rootDir, "samples");
const outputDir = path.join(rootDir, "docs", "benchmarks");
const baselinePath = path.join(outputDir, "baseline-context-snapshot.json");

// Must match scripts/context-baseline.mjs's CANONICAL_REQUEST so the two
// snapshots are directly comparable.
const CANONICAL_REQUEST = "Add invoice approval workflow";

async function main() {
  const { ContextMeasurementService } = await import(
    pathToFileURL(path.join(rootDir, "packages/measurement/dist/index.js")).href
  );
  const { SymbolGraphService } = await import(
    pathToFileURL(path.join(rootDir, "packages/graph/dist/index.js")).href
  );

  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  const baselineBySample = new Map(
    baseline.samples.map((entry) => [entry.sample, entry])
  );

  const sampleNames = (await readdir(samplesDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const service = new ContextMeasurementService();
  const results = [];

  for (const sampleName of sampleNames) {
    const repoRoot = path.join(samplesDir, sampleName);

    try {
      // Build the graph first so items #1/#2/#4 (graph-signal ranking,
      // graph-grounded citations) get a fair chance to contribute, same as
      // a real user running `graph` before `plan`.
      await new SymbolGraphService().build({ startPath: repoRoot, strictRoot: true });

      const measurement = await service.measure({
        startPath: repoRoot,
        strictRoot: true,
        request: CANONICAL_REQUEST
      });
      const before = baselineBySample.get(sampleName);

      results.push({
        sample: sampleName,
        request: CANONICAL_REQUEST,
        naiveWholeRepo: measurement.naiveWholeRepo,
        currentToolSelection: measurement.currentToolSelection,
        estimatedTokenReductionPercent: measurement.estimatedTokenReductionPercent,
        comparedToBaseline: before
          ? {
              beforeSelectedTokens: before.currentToolSelection.estimatedTokens,
              afterSelectedTokens: measurement.currentToolSelection.estimatedTokens,
              beforeReductionPercent: before.estimatedTokenReductionPercent,
              afterReductionPercent: measurement.estimatedTokenReductionPercent
            }
          : null
      });

      const deltaNote = before
        ? ` [before: ${before.currentToolSelection.estimatedTokens} tokens, ${before.estimatedTokenReductionPercent}% reduction]`
        : " [no baseline entry to compare]";
      console.log(
        `${sampleName}: naive ~${measurement.naiveWholeRepo.estimatedTokens} tokens (${measurement.naiveWholeRepo.fileCount} files) -> ` +
          `selected ~${measurement.currentToolSelection.estimatedTokens} tokens (${measurement.currentToolSelection.relevantFileCount} files), ` +
          `~${measurement.estimatedTokenReductionPercent}% smaller${deltaNote}`
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
        "For each sample repo, runs ContextMeasurementService.measure() (packages/measurement) " +
        "with the same canonical feature request as the baseline snapshot, and compares against " +
        "docs/benchmarks/baseline-context-snapshot.json — the 'before' data point captured ahead " +
        "of items #1-#4. Token counts are a rough chars/4 estimate, not a real tokenizer or a " +
        "GitHub Copilot billing measurement.",
      canonicalRequest: CANONICAL_REQUEST,
      charsPerTokenEstimate: 4,
      comparedAgainst: path.relative(rootDir, baselinePath)
    },
    samples: results
  };

  await mkdir(outputDir, { recursive: true });
  const snapshotPath = path.join(outputDir, "after-context-snapshot.json");
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`\nWrote ${path.relative(rootDir, snapshotPath)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
