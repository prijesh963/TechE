import type {
  BuildCommand,
  DiagnosticMessage,
  EntryPoint,
  FeaturePattern,
  FormatCommand,
  FrameworkInfo,
  LanguageInfo,
  LintCommand,
  PackageManagerInfo,
  RepoCommandSet,
  TestCommand,
  ValidationCommand
} from "@copilot-architect/shared";

import { AdapterCapability } from "./types.js";

export interface AdapterScoreInput {
  value: number;
  reasons?: string[];
}

export class AdapterScore {
  readonly value: number;
  readonly reasons: string[];

  constructor(input: AdapterScoreInput) {
    this.value = normalizeScore(input.value);
    this.reasons = input.reasons ?? [];
  }

  get confidence(): "low" | "medium" | "high" {
    if (this.value >= 0.75) {
      return "high";
    }

    if (this.value >= 0.4) {
      return "medium";
    }

    return "low";
  }
}

export interface AdapterDetectionResultInput {
  adapterName: string;
  adapterVersion: string;
  capabilities?: AdapterCapability[];
  score?: AdapterScore;
  languages?: LanguageInfo[];
  frameworks?: FrameworkInfo[];
  packageManagers?: PackageManagerInfo[];
  commands?: Partial<RepoCommandSet>;
  sourceFolders?: string[];
  testFolders?: string[];
  configFiles?: string[];
  entryPoints?: EntryPoint[];
  featurePatterns?: FeaturePattern[];
  architecturalPatterns?: string[];
  diagnostics?: DiagnosticMessage[];
}

export class AdapterDetectionResult {
  readonly adapterName: string;
  readonly adapterVersion: string;
  readonly capabilities: AdapterCapability[];
  readonly score: AdapterScore;
  readonly languages: LanguageInfo[];
  readonly frameworks: FrameworkInfo[];
  readonly packageManagers: PackageManagerInfo[];
  readonly commands: RepoCommandSet;
  readonly sourceFolders: string[];
  readonly testFolders: string[];
  readonly configFiles: string[];
  readonly entryPoints: EntryPoint[];
  readonly featurePatterns: FeaturePattern[];
  readonly architecturalPatterns: string[];
  readonly diagnostics: DiagnosticMessage[];

  constructor(input: AdapterDetectionResultInput) {
    this.adapterName = input.adapterName;
    this.adapterVersion = input.adapterVersion;
    this.capabilities = input.capabilities ?? [];
    this.score = input.score ?? new AdapterScore({ value: 0 });
    this.languages = input.languages ?? [];
    this.frameworks = input.frameworks ?? [];
    this.packageManagers = input.packageManagers ?? [];
    this.commands = {
      build: input.commands?.build ?? [],
      test: input.commands?.test ?? [],
      lint: input.commands?.lint ?? [],
      format: input.commands?.format ?? [],
      validation: input.commands?.validation ?? []
    };
    this.sourceFolders = input.sourceFolders ?? [];
    this.testFolders = input.testFolders ?? [];
    this.configFiles = input.configFiles ?? [];
    this.entryPoints = input.entryPoints ?? [];
    this.featurePatterns = input.featurePatterns ?? [];
    this.architecturalPatterns = input.architecturalPatterns ?? [];
    this.diagnostics = input.diagnostics ?? [];
  }

  static empty(adapterName: string, adapterVersion: string): AdapterDetectionResult {
    return new AdapterDetectionResult({
      adapterName,
      adapterVersion,
      score: new AdapterScore({ value: 0 })
    });
  }
}

export class GenericFallbackResult extends AdapterDetectionResult {
  readonly fallbackReason: string;

  constructor(
    input: AdapterDetectionResultInput & {
      fallbackReason: string;
    }
  ) {
    super(input);
    this.fallbackReason = input.fallbackReason;
  }
}

export function mergeAdapterDetectionResults(
  results: AdapterDetectionResult[]
): AdapterDetectionResult {
  if (results.length === 0) {
    return AdapterDetectionResult.empty("merged", "0.1.0");
  }

  return new AdapterDetectionResult({
    adapterName: "merged",
    adapterVersion: "0.1.0",
    capabilities: uniqueCapabilities(results.flatMap((result) => result.capabilities)),
    score: new AdapterScore({
      value: Math.max(...results.map((result) => result.score.value)),
      reasons: results.flatMap((result) => result.score.reasons)
    }),
    languages: uniqueBy(
      results.flatMap((result) => result.languages),
      (language) => language.name.toLowerCase(),
      rankConfidence
    ),
    frameworks: uniqueBy(
      results.flatMap((result) => result.frameworks),
      (framework) => `${framework.ecosystem}:${framework.name}`.toLowerCase(),
      rankConfidence
    ),
    packageManagers: uniqueBy(
      results.flatMap((result) => result.packageManagers),
      (manager) =>
        `${manager.name}:${manager.manifest ?? ""}:${manager.lockfile ?? ""}`.toLowerCase(),
      rankConfidence
    ),
    commands: {
      build: uniqueCommands(results.flatMap((result) => result.commands.build)),
      test: uniqueCommands(results.flatMap((result) => result.commands.test)),
      lint: uniqueCommands(results.flatMap((result) => result.commands.lint)),
      format: uniqueCommands(results.flatMap((result) => result.commands.format)),
      validation: uniqueCommands(
        results.flatMap((result) => result.commands.validation)
      )
    },
    sourceFolders: uniqueStrings(results.flatMap((result) => result.sourceFolders)),
    testFolders: uniqueStrings(results.flatMap((result) => result.testFolders)),
    configFiles: uniqueStrings(results.flatMap((result) => result.configFiles)),
    entryPoints: uniqueBy(
      results.flatMap((result) => result.entryPoints),
      (entryPoint) =>
        `${entryPoint.kind}:${entryPoint.filePath}:${entryPoint.command ?? ""}`,
      rankConfidence
    ),
    featurePatterns: uniqueBy(
      results.flatMap((result) => result.featurePatterns),
      (pattern) => pattern.id,
      rankConfidence
    ),
    architecturalPatterns: uniqueStrings(
      results.flatMap((result) => result.architecturalPatterns)
    ),
    diagnostics: uniqueBy(
      results.flatMap((result) => result.diagnostics),
      (diagnostic) =>
        `${diagnostic.severity}:${diagnostic.code}:${diagnostic.filePath ?? ""}:${diagnostic.message}`,
      rankSeverity
    )
  });
}

function normalizeScore(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function uniqueCapabilities(capabilities: AdapterCapability[]): AdapterCapability[] {
  return uniqueBy(
    capabilities,
    (capability) => `${capability.kind}:${capability.name}`,
    () => 0
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function uniqueCommands<T extends AnyCommand>(commands: T[]): T[] {
  return uniqueBy(commands, commandKey, rankConfidence);
}

function uniqueBy<T>(
  values: T[],
  keySelector: (value: T) => string,
  rankSelector: (value: T) => number
): T[] {
  const byKey = new Map<string, T>();

  for (const value of values) {
    const key = keySelector(value);
    const existing = byKey.get(key);

    if (!existing || rankSelector(value) > rankSelector(existing)) {
      byKey.set(key, value);
    }
  }

  return [...byKey.values()];
}

type AnyCommand =
  BuildCommand | TestCommand | LintCommand | FormatCommand | ValidationCommand;

function commandKey(command: AnyCommand): string {
  return [command.kind, command.cwd ?? "", command.command, ...command.args].join(
    "\u0000"
  );
}

function rankConfidence(value: { confidence: "low" | "medium" | "high" }): number {
  switch (value.confidence) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
  }
}

function rankSeverity(value: DiagnosticMessage): number {
  switch (value.severity) {
    case "error":
      return 3;
    case "warning":
      return 2;
    case "info":
      return 1;
  }
}
