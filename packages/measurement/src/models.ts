import type { GeneratedArtifact } from "@copilot-architect/shared";

export interface ContextMeasurementOptions {
  startPath?: string;
  strictRoot?: boolean;
  request: string;
}

export interface ContextMeasurement extends GeneratedArtifact {
  repoRoot: string;
  request: string;
  naiveWholeRepo: {
    fileCount: number;
    totalBytes: number;
    estimatedTokens: number;
  };
  currentToolSelection: {
    relevantFileCount: number;
    likelyFilesToModifyCount: number;
    filesReadableOnDisk: number;
    totalBytes: number;
    estimatedTokens: number;
  };
  /** Rounded to one decimal place; 0 when the naive repo has no measurable content. */
  estimatedTokenReductionPercent: number;
}
