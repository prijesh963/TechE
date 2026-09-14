import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  CURRENT_SCHEMA_VERSION,
  type AdvancedAnalysis,
  type AdvancedArchitecturePattern,
  type AdvancedRiskScore,
  type DependencyManifest,
  type FileChangeActivity,
  type RepoMap,
  type RepoReadinessDiagnostic,
  type RouteApiEndpoint,
  type TestRelationship,
  type UniversalRepoMap,
  findRepoRoot,
  getArtifactDirectoryPath,
  getArtifactFilePath,
  isBinaryPath,
  readJsonFile,
  scanRepository
} from "@copilot-architect/shared";

import { RepoDiscoveryService } from "./repo-discovery.js";

export interface AdvancedAnalysisOptions {
  startPath?: string;
  request?: string;
  repoMap?: UniversalRepoMap;
}

export interface RepoReadinessReport {
  schemaVersion: string;
  generatedAt: string;
  repoRoot: string;
  status: "ok" | "warning" | "error";
  score: number;
  diagnostics: RepoReadinessDiagnostic[];
  advancedAnalysis: AdvancedAnalysis;
}

interface ScannedFile {
  relativePath: string;
  fullPath: string;
  text?: string;
  mtimeMs: number;
}

const execFileAsync = promisify(execFile);
const maxTextBytes = 512_000;

export class AdvancedAnalysisService {
  async analyze(options: AdvancedAnalysisOptions = {}): Promise<AdvancedAnalysis> {
    const startPath = path.resolve(options.startPath ?? process.cwd());
    const repoMap = options.repoMap ?? (await loadOrCreateRepoMap(startPath));
    const repo = repoMap.repos[0];

    if (!repo) {
      throw new Error("Repo map does not contain any repositories");
    }

    const files = await scanRepoFiles(repo.repoRoot);
    const dependencyManifests = await detectDependencyManifests(repo.repoRoot, files);
    const routes = detectRoutes(files);
    const testRelationships = detectTestRelationships(files, routes);
    const architecturePatterns = detectArchitecturePatterns(repoMap, repo, files);
    const diagnostics = await createReadinessDiagnostics(repo.repoRoot, repo, files);
    const gitActivity = await collectGitActivity(repo.repoRoot);
    const riskScores = scoreRisks({
      repoMap,
      repo,
      dependencyManifests,
      routes,
      testRelationships,
      diagnostics,
      gitActivity,
      request: options.request
    });

    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      repoRoot: repo.repoRoot,
      summary: summarizeAdvancedAnalysis({
        architecturePatterns,
        dependencyManifests,
        routes,
        testRelationships,
        riskScores,
        diagnostics,
        gitActivity
      }),
      architecturePatterns,
      dependencyManifests,
      routes,
      testRelationships,
      riskScores,
      diagnostics,
      gitActivity
    };
  }

  async diagnose(options: AdvancedAnalysisOptions = {}): Promise<RepoReadinessReport> {
    const startPath = path.resolve(options.startPath ?? process.cwd());
    const repoRoot = await findRepoRoot(startPath);
    const repoMapPath = getArtifactFilePath(repoRoot, "repoMap");
    const repoMapExists = await pathExists(repoMapPath);
    const repoMap = repoMapExists
      ? await readJsonFile<UniversalRepoMap>(repoMapPath)
      : (await new RepoDiscoveryService().analyze({ startPath: repoRoot })).repoMap;
    const advancedAnalysis = await this.analyze({
      startPath: repoRoot,
      request: options.request,
      repoMap
    });
    const diagnostics = repoMapExists
      ? advancedAnalysis.diagnostics
      : [
          {
            code: "MISSING_REPO_MAP" as const,
            severity: "warning" as const,
            message: "Repo map artifact was missing before diagnostics ran.",
            recommendation: "Run `npm run cli -- analyze` before planning."
          },
          ...advancedAnalysis.diagnostics.filter(
            (diagnostic) => diagnostic.code !== "MISSING_REPO_MAP"
          )
        ];
    const score = scoreReadiness(diagnostics);
    const status = diagnostics.some((diagnostic) => diagnostic.severity === "error")
      ? "error"
      : diagnostics.some((diagnostic) => diagnostic.severity === "warning")
        ? "warning"
        : "ok";

    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      repoRoot,
      status,
      score,
      diagnostics,
      advancedAnalysis: {
        ...advancedAnalysis,
        diagnostics
      }
    };
  }
}

async function loadOrCreateRepoMap(startPath: string): Promise<UniversalRepoMap> {
  const repoRoot = await findRepoRoot(startPath);

  try {
    return await readJsonFile<UniversalRepoMap>(
      getArtifactFilePath(repoRoot, "repoMap")
    );
  } catch {
    return (await new RepoDiscoveryService().analyze({ startPath: repoRoot })).repoMap;
  }
}

async function scanRepoFiles(repoRoot: string): Promise<ScannedFile[]> {
  const entries = await scanRepository(repoRoot);
  const files: ScannedFile[] = [];

  for (const entry of entries) {
    const scanned: ScannedFile = {
      relativePath: entry.relativePath,
      fullPath: entry.absolutePath,
      mtimeMs: entry.modifiedTimeMs
    };

    if (entry.sizeBytes <= maxTextBytes && shouldReadText(entry.relativePath)) {
      try {
        scanned.text = await readFile(entry.absolutePath, "utf8");
      } catch {
        // Keep path-only evidence for unreadable text files.
      }
    }

    files.push(scanned);
  }

  return files.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath)
  );
}

function detectArchitecturePatterns(
  repoMap: UniversalRepoMap,
  repo: RepoMap,
  files: ScannedFile[]
): AdvancedArchitecturePattern[] {
  const frameworks = new Set(repo.frameworks.map((framework) => framework.name));
  const languages = new Set(repo.languages.map((language) => language.name));
  const filePaths = new Set(files.map((file) => file.relativePath));
  const packageJsonFiles = files.filter(
    (file) => path.basename(file.relativePath) === "package.json"
  );
  const patterns: AdvancedArchitecturePattern[] = [];

  if (frameworks.has("React") || hasDependency(packageJsonFiles, "react")) {
    patterns.push({
      name: "React app",
      confidence: frameworks.has("React") ? "high" : "medium",
      evidence: evidence([
        "React framework/dependency",
        firstExisting(filePaths, ["src/App.tsx", "src/App.jsx", "app/page.tsx"])
      ])
    });
  }

  if (frameworks.has("Angular") || filePaths.has("angular.json")) {
    patterns.push({
      name: "Angular app",
      confidence: filePaths.has("angular.json") ? "high" : "medium",
      evidence: evidence([
        "Angular framework/dependency",
        firstExisting(filePaths, ["angular.json", "src/app/app.module.ts"])
      ])
    });
  }

  if (
    frameworks.has("Node.js") ||
    hasDependency(packageJsonFiles, "express") ||
    hasDependency(packageJsonFiles, "fastify") ||
    hasDependency(packageJsonFiles, "@nestjs/core")
  ) {
    patterns.push({
      name: "Node API",
      confidence: hasDependency(packageJsonFiles, "express") ? "high" : "medium",
      evidence: evidence([
        "Node API dependency/config",
        firstExisting(filePaths, ["src/server.ts", "src/index.ts", "server.js"])
      ])
    });
  }

  if (
    languages.has("Python") &&
    (frameworks.has("FastAPI") || frameworks.has("Flask") || frameworks.has("Django"))
  ) {
    patterns.push({
      name: "Python service",
      confidence: "high",
      evidence: evidence([
        `Python framework: ${["FastAPI", "Flask", "Django"].filter((name) => frameworks.has(name)).join(", ")}`
      ])
    });
  }

  if (languages.has("Java") && frameworks.has("Spring Boot")) {
    patterns.push({
      name: "Java Spring service",
      confidence: "high",
      evidence: ["Spring Boot framework evidence"]
    });
  }

  if (
    repoMap.summary.repoCount > 1 ||
    repo.projects.length > 1 ||
    repo.architecturalPatterns.includes("monorepo")
  ) {
    patterns.push({
      name: "monorepo",
      confidence: repo.projects.length > 1 ? "high" : "medium",
      evidence: [`${repo.projects.length} project root(s) detected`]
    });
  }

  if (
    packageJsonFiles.some((file) =>
      packageJsonHasAny(file.text, ["main", "exports", "types"])
    ) ||
    files.some((file) =>
      /(?:^|\/)(setup\.py|pyproject\.toml|pom\.xml|build\.gradle(?:\.kts)?)$/.test(
        file.relativePath
      )
    )
  ) {
    patterns.push({
      name: "library/package",
      confidence: "medium",
      evidence: ["Package/library manifest detected"]
    });
  }

  if (
    packageJsonFiles.some((file) => packageJsonHasAny(file.text, ["bin"])) ||
    files.some((file) =>
      /(^|\/)(cli|commands?)\.(ts|js|py|java)$/.test(file.relativePath.toLowerCase())
    )
  ) {
    patterns.push({
      name: "CLI app",
      confidence: "medium",
      evidence: ["CLI entry point or package bin detected"]
    });
  }

  return dedupeByName(patterns);
}

async function detectDependencyManifests(
  repoRoot: string,
  files: ScannedFile[]
): Promise<DependencyManifest[]> {
  const manifests = await Promise.all(
    files
      .filter((file) =>
        dependencyManifestPatterns.some((pattern) => pattern.test(file.relativePath))
      )
      .map(async (file) => ({
        filePath: file.relativePath,
        ecosystem: ecosystemForManifest(file.relativePath),
        packageManager: packageManagerForManifest(file.relativePath),
        changed: await isGitChanged(repoRoot, file.relativePath),
        evidence: [`Detected ${path.basename(file.relativePath)}`]
      }))
  );

  return manifests.sort((left, right) => left.filePath.localeCompare(right.filePath));
}

function detectRoutes(files: ScannedFile[]): RouteApiEndpoint[] {
  return files.flatMap((file) => {
    const text = file.text;

    if (!text || isTestFile(file.relativePath)) {
      return [];
    }

    return [
      ...detectExpressRoutes(file, text),
      ...detectPythonRoutes(file, text),
      ...detectDjangoRoutes(file, text),
      ...detectSpringRoutes(file, text),
      ...detectAngularRoutes(file, text),
      ...detectReactRoutes(file, text),
      ...detectNextRoutes(file)
    ];
  });
}

function detectExpressRoutes(file: ScannedFile, text: string): RouteApiEndpoint[] {
  if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(file.relativePath)) {
    return [];
  }

  const routes: RouteApiEndpoint[] = [];
  const pattern =
    /\b(?:app|router)\.(get|post|put|patch|delete|all)\(\s*["'`]([^"'`]+)["'`]\s*,?\s*([A-Za-z_$][\w$]*)?/g;

  for (const match of text.matchAll(pattern)) {
    routes.push({
      kind: "express",
      method: match[1]?.toUpperCase() ?? "ANY",
      routePath: match[2] ?? "/",
      filePath: file.relativePath,
      line: lineNumberAt(text, match.index ?? 0),
      handler: match[3]
    });
  }

  return routes;
}

function detectPythonRoutes(file: ScannedFile, text: string): RouteApiEndpoint[] {
  if (!file.relativePath.endsWith(".py")) {
    return [];
  }

  const routes: RouteApiEndpoint[] = [];
  const fastApiPattern =
    /@(app|router)\.(get|post|put|patch|delete|api_route)\(\s*["']([^"']+)["']/g;
  const flaskPattern =
    /@(?:app|blueprint)\.route\(\s*["']([^"']+)["'](?:,\s*methods\s*=\s*\[([^\]]+)\])?/g;

  for (const match of text.matchAll(fastApiPattern)) {
    routes.push({
      kind: "fastapi",
      method: match[2] === "api_route" ? "ANY" : (match[2]?.toUpperCase() ?? "ANY"),
      routePath: match[3] ?? "/",
      filePath: file.relativePath,
      line: lineNumberAt(text, match.index ?? 0)
    });
  }

  for (const match of text.matchAll(flaskPattern)) {
    routes.push({
      kind: "flask",
      method: parseFlaskMethod(match[2]),
      routePath: match[1] ?? "/",
      filePath: file.relativePath,
      line: lineNumberAt(text, match.index ?? 0)
    });
  }

  return routes;
}

function detectDjangoRoutes(file: ScannedFile, text: string): RouteApiEndpoint[] {
  if (
    !file.relativePath.endsWith(".py") ||
    !file.relativePath.toLowerCase().includes("url")
  ) {
    return [];
  }

  const routes: RouteApiEndpoint[] = [];
  const pattern = /\b(?:path|re_path)\(\s*["']([^"']*)["']/g;

  for (const match of text.matchAll(pattern)) {
    routes.push({
      kind: "django",
      method: "ANY",
      routePath: `/${match[1] ?? ""}`.replace(/\/+/g, "/"),
      filePath: file.relativePath,
      line: lineNumberAt(text, match.index ?? 0)
    });
  }

  return routes;
}

function detectSpringRoutes(file: ScannedFile, text: string): RouteApiEndpoint[] {
  if (!file.relativePath.endsWith(".java")) {
    return [];
  }

  const routes: RouteApiEndpoint[] = [];
  const classMapping =
    text.match(/@RequestMapping\(\s*(?:value\s*=\s*)?["']([^"']+)["']/)?.[1] ?? "";
  const pattern =
    /@(GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping|RequestMapping)\(\s*(?:value\s*=\s*)?["']?([^"')]*)["']?/g;

  for (const match of text.matchAll(pattern)) {
    const annotation = match[1] ?? "RequestMapping";
    const routePath = joinRoutes(classMapping, match[2] ?? "");

    routes.push({
      kind: "spring",
      method: springMethod(annotation),
      routePath,
      filePath: file.relativePath,
      line: lineNumberAt(text, match.index ?? 0)
    });
  }

  return routes;
}

function detectAngularRoutes(file: ScannedFile, text: string): RouteApiEndpoint[] {
  if (
    !file.relativePath.endsWith(".ts") ||
    !file.relativePath.toLowerCase().includes("routing")
  ) {
    return [];
  }

  const routes: RouteApiEndpoint[] = [];
  const pattern = /\bpath\s*:\s*["']([^"']*)["']/g;

  for (const match of text.matchAll(pattern)) {
    routes.push({
      kind: "angular",
      method: "PAGE",
      routePath: `/${match[1] ?? ""}`.replace(/\/+/g, "/"),
      filePath: file.relativePath,
      line: lineNumberAt(text, match.index ?? 0)
    });
  }

  return routes;
}

function detectReactRoutes(file: ScannedFile, text: string): RouteApiEndpoint[] {
  if (!/\.(?:tsx|jsx|ts|js)$/.test(file.relativePath)) {
    return [];
  }

  const routes: RouteApiEndpoint[] = [];
  const pattern = /<(?:Route)\b[^>]*\bpath=["']([^"']+)["']/g;

  for (const match of text.matchAll(pattern)) {
    routes.push({
      kind: "react",
      method: "PAGE",
      routePath: match[1] ?? "/",
      filePath: file.relativePath,
      line: lineNumberAt(text, match.index ?? 0)
    });
  }

  return routes;
}

function detectNextRoutes(file: ScannedFile): RouteApiEndpoint[] {
  const normalized = file.relativePath;
  const routeMatch = normalized.match(/^(?:src\/)?app\/(.+)\/route\.(ts|js)$/);
  const pageMatch = normalized.match(
    /^(?:src\/)?(?:app|pages)\/(.+)\.(tsx|jsx|ts|js)$/
  );

  if (routeMatch?.[1]) {
    return [
      {
        kind: "next",
        method: "ANY",
        routePath: `/${routeMatch[1]}`.replace(/\/+/g, "/"),
        filePath: normalized
      }
    ];
  }

  if (pageMatch?.[1] && !pageMatch[1].startsWith("_")) {
    return [
      {
        kind: "next",
        method: "PAGE",
        routePath: `/${pageMatch[1].replace(/\/page$/, "")}`.replace(/\/+/g, "/"),
        filePath: normalized
      }
    ];
  }

  return [];
}

function detectTestRelationships(
  files: ScannedFile[],
  routes: RouteApiEndpoint[]
): TestRelationship[] {
  const testFiles = files.filter((file) => isTestFile(file.relativePath));
  const testPathSet = new Set(testFiles.map((file) => file.relativePath));
  const relationships: TestRelationship[] = [];

  for (const file of files) {
    if (isTestFile(file.relativePath)) {
      continue;
    }

    const kind = inferRelationshipKind(file.relativePath);

    if (!kind) {
      continue;
    }

    const match =
      findSiblingTest(file.relativePath, testPathSet) ??
      findNamedTest(file.relativePath, testFiles);

    relationships.push({
      kind,
      sourceFile: file.relativePath,
      testFile: match,
      confidence: match ? "high" : "low",
      reason: match
        ? "Matched source file to nearby spec/test file."
        : "No nearby spec/test file was found."
    });
  }

  for (const route of routes) {
    const routeTest = findRouteTest(route, testFiles);
    relationships.push({
      kind: "api-route",
      sourceFile: route.filePath,
      testFile: routeTest,
      routePath: route.routePath,
      confidence: routeTest ? "medium" : "low",
      reason: routeTest
        ? "Matched route to integration-style test by route segment or file name."
        : "No integration-style route test was found."
    });
  }

  return dedupeRelationships(relationships).slice(0, 200);
}

async function createReadinessDiagnostics(
  repoRoot: string,
  repo: RepoMap,
  files: ScannedFile[]
): Promise<RepoReadinessDiagnostic[]> {
  const diagnostics: RepoReadinessDiagnostic[] = [];
  const repoMapPath = getArtifactFilePath(repoRoot, "repoMap");
  const indexPath = path.join(
    getArtifactDirectoryPath(repoRoot, "index"),
    "index.json"
  );
  const repoMapExists = await pathExists(repoMapPath);
  const indexStats = await tryStat(indexPath);
  const newestSourceMtime = Math.max(0, ...files.map((file) => file.mtimeMs));

  if (!repoMapExists) {
    diagnostics.push({
      code: "MISSING_REPO_MAP",
      severity: "warning",
      message: "Repo map artifact is missing.",
      recommendation: "Run `npm run cli -- analyze`."
    });
  }

  if (repo.packageManagers.length === 0 && hasDependencyManifest(files)) {
    diagnostics.push({
      code: "MISSING_PACKAGE_MANAGER",
      severity: "warning",
      message: "Dependency manifests exist, but no package manager was detected.",
      recommendation: "Check lockfiles or add custom command configuration."
    });
  }

  if (repo.commands.build.length === 0) {
    diagnostics.push({
      code: "MISSING_BUILD_SCRIPT",
      severity: "warning",
      message: "No build command was detected.",
      recommendation:
        "Add a build script or configure `.copilot-architect/commands.json`."
    });
  }

  if (
    repo.commands.test.length === 0 ||
    !files.some((file) => isTestFile(file.relativePath))
  ) {
    diagnostics.push({
      code: "MISSING_TESTS",
      severity: "warning",
      message: "No complete test signal was detected.",
      recommendation: "Add tests or configure a safe validation command."
    });
  }

  if (!indexStats || indexStats.mtimeMs < newestSourceMtime) {
    diagnostics.push({
      code: "STALE_INDEX",
      severity: "warning",
      message: indexStats
        ? "Local index appears older than repository files."
        : "Local index is missing.",
      recommendation: "Run `npm run cli -- index`."
    });
  }

  if (diagnostics.length === 0) {
    diagnostics.push({
      code: "READY",
      severity: "info",
      message:
        "Repository has repo-map, index, package manager, build, and test signals."
    });
  }

  return diagnostics;
}

const GIT_ACTIVITY_MAX_COMMITS = 500;
const GIT_ACTIVITY_MAX_FILES = 50;

/**
 * One `git log` walk over the last `GIT_ACTIVITY_MAX_COMMITS` commits,
 * aggregated per file into commit count (a proxy for coupling/importance a
 * one-shot repo scan cannot see) and last-touched recency. Never one `git
 * log` per file — cost stays bounded regardless of repo size. Degrades to
 * `[]` on any failure: no `.git` directory, git unavailable, or an empty
 * history are all expected, not errors.
 */
export async function collectGitActivity(
  repoRoot: string
): Promise<FileChangeActivity[]> {
  let stdout: string;

  try {
    const result = await execFileAsync(
      "git",
      [
        "log",
        "-n",
        String(GIT_ACTIVITY_MAX_COMMITS),
        "--pretty=format:%x00%aI",
        "--name-only"
      ],
      { cwd: repoRoot, maxBuffer: 10 * 1024 * 1024 }
    );
    stdout = result.stdout;
  } catch {
    return [];
  }

  const activityByFile = new Map<
    string,
    { commitCount: number; lastChangedAt: string }
  >();
  let currentTimestamp: string | undefined;

  for (const rawLine of stdout.split("\n")) {
    if (rawLine.startsWith(" ")) {
      currentTimestamp = rawLine.slice(1).trim();
      continue;
    }

    const filePath = rawLine.trim();
    if (!filePath || !currentTimestamp) {
      continue;
    }

    const existing = activityByFile.get(filePath);
    if (existing) {
      existing.commitCount += 1;
      // git log is newest-first, so the first timestamp seen per file is
      // already its most recent — never overwrite lastChangedAt here.
    } else {
      activityByFile.set(filePath, { commitCount: 1, lastChangedAt: currentTimestamp });
    }
  }

  const now = Date.now();

  return [...activityByFile.entries()]
    .map(([filePath, activity]) => ({
      filePath,
      commitCount: activity.commitCount,
      lastChangedAt: activity.lastChangedAt,
      lastChangedDaysAgo: Math.max(
        0,
        Math.round(
          (now - new Date(activity.lastChangedAt).getTime()) / (24 * 60 * 60 * 1000)
        )
      )
    }))
    .sort(
      (left, right) =>
        right.commitCount - left.commitCount ||
        left.lastChangedDaysAgo - right.lastChangedDaysAgo
    )
    .slice(0, GIT_ACTIVITY_MAX_FILES);
}

function scoreRisks(input: {
  repoMap: UniversalRepoMap;
  repo: RepoMap;
  dependencyManifests: DependencyManifest[];
  routes: RouteApiEndpoint[];
  testRelationships: TestRelationship[];
  diagnostics: RepoReadinessDiagnostic[];
  gitActivity: FileChangeActivity[];
  request?: string;
}): AdvancedRiskScore[] {
  const request = input.request?.toLowerCase() ?? "";
  const routeText = input.routes
    .map((route) => route.routePath.toLowerCase())
    .join(" ");
  const securitySignals = [request, routeText].filter((text) =>
    /(auth|permission|role|admin|token|secret|approval|login|security)/.test(text)
  );
  const dependencyChanged = input.dependencyManifests.filter(
    (manifest) => manifest.changed
  );
  const missingTests = input.testRelationships.filter(
    (relationship) => !relationship.testFile
  );
  const hotspotFiles = new Set(
    input.gitActivity
      .filter((activity) => activity.commitCount >= 3)
      .map((activity) => activity.filePath)
  );
  const missingTestHotspots = missingTests.filter((relationship) =>
    hotspotFiles.has(relationship.sourceFile)
  );
  const migrationSignals = [
    request,
    ...input.repo.featurePatterns.map((pattern) => pattern.summary.toLowerCase())
  ].filter((text) =>
    /(migration|schema|database|persist|state|approval|invoice)/.test(text)
  );
  const multiRepoSignals =
    input.repoMap.summary.repoCount > 1 || input.repo.projects.length > 1;

  return [
    createRiskScore({
      category: "security",
      score: Math.min(100, 25 + input.routes.length * 5 + securitySignals.length * 30),
      reasons:
        securitySignals.length > 0
          ? ["Request or routes include security-sensitive workflow terms."]
          : input.routes.length > 0
            ? ["API or route surfaces are present."]
            : ["No security-sensitive routes or request terms detected."],
      mitigation:
        "Confirm authorization, audit logging, and secret redaction boundaries."
    }),
    createRiskScore({
      category: "data-migration",
      score: migrationSignals.length > 0 ? 70 : 25,
      reasons:
        migrationSignals.length > 0
          ? ["Request or repo evidence suggests persisted state or schema changes."]
          : ["No migration-specific evidence detected."],
      mitigation: "Check model/schema ownership before changing persisted data."
    }),
    createRiskScore({
      category: "dependency",
      score:
        dependencyChanged.length > 0
          ? 80
          : input.dependencyManifests.length > 0
            ? 35
            : 20,
      reasons:
        dependencyChanged.length > 0
          ? [
              `Changed dependency manifest(s): ${dependencyChanged.map((manifest) => manifest.filePath).join(", ")}.`
            ]
          : input.dependencyManifests.length > 0
            ? [
                "Dependency manifests are present; avoid unnecessary dependency changes."
              ]
            : ["No dependency manifests detected."],
      mitigation: "Require install/build/test evidence for dependency changes."
    }),
    createRiskScore({
      category: "multi-repo-impact",
      score: multiRepoSignals ? 70 : 20,
      reasons: multiRepoSignals
        ? ["Multiple project or repo roots are present."]
        : ["Single project/repo shape detected."],
      mitigation: "Use workspace impact analysis for cross-repo changes."
    }),
    createRiskScore({
      category: "missing-test",
      score:
        missingTestHotspots.length > 0
          ? 90
          : input.diagnostics.some(
                (diagnostic) => diagnostic.code === "MISSING_TESTS"
              ) || missingTests.length > 0
            ? 75
            : 20,
      reasons:
        missingTests.length > 0
          ? [
              `${missingTests.length} source/route relationship(s) have no nearby test.`,
              ...(missingTestHotspots.length > 0
                ? [
                    `${missingTestHotspots.length} of those change frequently (${missingTestHotspots
                      .map((relationship) => relationship.sourceFile)
                      .join(", ")}) — untested hotspots compound risk.`
                  ]
                : [])
            ]
          : [
              "Detected source/test relationships are covered or no source relationships were found."
            ],
      mitigation: "Add focused tests near changed components, services, or API routes."
    })
  ];
}

function createRiskScore(input: {
  category: AdvancedRiskScore["category"];
  score: number;
  reasons: string[];
  mitigation: string;
}): AdvancedRiskScore {
  const score = Math.max(0, Math.min(100, Math.round(input.score)));

  return {
    category: input.category,
    score,
    level: score >= 70 ? "high" : score >= 40 ? "medium" : "low",
    reasons: input.reasons,
    mitigation: input.mitigation
  };
}

function summarizeAdvancedAnalysis(input: {
  architecturePatterns: AdvancedArchitecturePattern[];
  dependencyManifests: DependencyManifest[];
  routes: RouteApiEndpoint[];
  testRelationships: TestRelationship[];
  riskScores: AdvancedRiskScore[];
  diagnostics: RepoReadinessDiagnostic[];
  gitActivity: FileChangeActivity[];
}): string {
  const highRisks = input.riskScores.filter((risk) => risk.level === "high");

  return [
    `${input.architecturePatterns.length} architecture pattern(s)`,
    `${input.dependencyManifests.length} dependency manifest(s)`,
    `${input.routes.length} route/API surface(s)`,
    `${input.testRelationships.length} test relationship(s)`,
    `${highRisks.length} high risk score(s)`,
    `${input.diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length} readiness warning(s)`,
    `${input.gitActivity.length} file(s) with recent git activity`
  ].join(", ");
}

function scoreReadiness(diagnostics: RepoReadinessDiagnostic[]): number {
  const penalty = diagnostics.reduce((total, diagnostic) => {
    if (diagnostic.severity === "error") {
      return total + 35;
    }

    if (diagnostic.severity === "warning") {
      return total + 15;
    }

    return total;
  }, 0);

  return Math.max(0, 100 - penalty);
}

function inferRelationshipKind(filePath: string): TestRelationship["kind"] | undefined {
  const lower = filePath.toLowerCase();

  if (
    /(component|page|view)\.(tsx|jsx|ts|js)$/.test(lower) ||
    /\.(tsx|jsx)$/.test(lower)
  ) {
    return "component";
  }

  if (/(service|controller|handler|repository)\.(ts|js|py|java)$/.test(lower)) {
    return "service";
  }

  return undefined;
}

function findSiblingTest(
  sourceFile: string,
  testPaths: Set<string>
): string | undefined {
  const parsed = path.posix.parse(sourceFile);
  const suffixes = [
    `.test${parsed.ext}`,
    `.spec${parsed.ext}`,
    `.test.ts`,
    `.spec.ts`,
    `.test.tsx`,
    `.spec.tsx`
  ];

  for (const suffix of suffixes) {
    const candidate = path.posix.join(parsed.dir, `${parsed.name}${suffix}`);

    if (testPaths.has(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function findNamedTest(
  sourceFile: string,
  testFiles: ScannedFile[]
): string | undefined {
  const sourceName = path.basename(sourceFile, path.extname(sourceFile)).toLowerCase();
  const normalizedSourceName = sourceName.replace(
    /(component|service|controller|handler)$/i,
    ""
  );

  return testFiles.find((file) => {
    const lower = file.relativePath.toLowerCase();
    return lower.includes(sourceName) || lower.includes(normalizedSourceName);
  })?.relativePath;
}

function findRouteTest(
  route: RouteApiEndpoint,
  testFiles: ScannedFile[]
): string | undefined {
  const routeSegments = route.routePath
    .toLowerCase()
    .split("/")
    .map((segment) => segment.replace(/[:{}[\]]/g, ""))
    .filter((segment) => segment.length > 2);
  const routeFileBase = path
    .basename(route.filePath, path.extname(route.filePath))
    .toLowerCase();

  return testFiles.find((file) => {
    const lower = `${file.relativePath.toLowerCase()}\n${file.text?.toLowerCase() ?? ""}`;
    return (
      lower.includes(routeFileBase) ||
      routeSegments.some((segment) => lower.includes(segment))
    );
  })?.relativePath;
}

function dedupeRelationships(relationships: TestRelationship[]): TestRelationship[] {
  const seen = new Set<string>();
  const output: TestRelationship[] = [];

  for (const relationship of relationships) {
    const key = `${relationship.kind}:${relationship.sourceFile}:${relationship.testFile ?? ""}:${relationship.routePath ?? ""}`;

    if (!seen.has(key)) {
      seen.add(key);
      output.push(relationship);
    }
  }

  return output;
}

function parseFlaskMethod(methods: string | undefined): string {
  if (!methods) {
    return "GET";
  }

  const match = methods.match(/["']([A-Z]+)["']/);
  return match?.[1] ?? "ANY";
}

function springMethod(annotation: string): string {
  return annotation.replace("Mapping", "").replace("Request", "ANY").toUpperCase();
}

function joinRoutes(prefix: string, routePath: string): string {
  const joined = `/${prefix}/${routePath}`.replace(/\/+/g, "/");
  return joined === "/" ? "/" : joined.replace(/\/$/, "");
}

function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.includes("/test/") ||
    lower.includes("/tests/") ||
    lower.includes(".test.") ||
    lower.includes(".spec.") ||
    lower.includes("test_") ||
    lower.endsWith("tests.java")
  );
}

function hasDependencyManifest(files: ScannedFile[]): boolean {
  return files.some((file) =>
    dependencyManifestPatterns.some((pattern) => pattern.test(file.relativePath))
  );
}

const dependencyManifestPatterns = [
  /(^|\/)package\.json$/,
  /(^|\/)requirements\.txt$/,
  /(^|\/)pyproject\.toml$/,
  /(^|\/)pom\.xml$/,
  /(^|\/)build\.gradle(\.kts)?$/
];

function ecosystemForManifest(filePath: string): DependencyManifest["ecosystem"] {
  if (filePath.endsWith("package.json")) {
    return "javascript";
  }

  if (filePath.endsWith("requirements.txt") || filePath.endsWith("pyproject.toml")) {
    return "python";
  }

  return "java";
}

function packageManagerForManifest(filePath: string): string {
  if (filePath.endsWith("package.json")) {
    return "npm";
  }

  if (filePath.endsWith("requirements.txt")) {
    return "pip";
  }

  if (filePath.endsWith("pyproject.toml")) {
    return "pyproject";
  }

  if (filePath.endsWith("pom.xml")) {
    return "maven";
  }

  return "gradle";
}

async function isGitChanged(repoRoot: string, relativePath: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--short", "--", relativePath],
      {
        cwd: repoRoot
      }
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function tryStat(filePath: string): Promise<{ mtimeMs: number } | undefined> {
  try {
    return await stat(filePath);
  } catch {
    return undefined;
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function hasDependency(packageJsonFiles: ScannedFile[], dependency: string): boolean {
  return packageJsonFiles.some((file) => {
    try {
      const parsed = JSON.parse(file.text ?? "{}") as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      return Boolean(
        parsed.dependencies?.[dependency] ?? parsed.devDependencies?.[dependency]
      );
    } catch {
      return false;
    }
  });
}

function packageJsonHasAny(text: string | undefined, keys: string[]): boolean {
  try {
    const parsed = JSON.parse(text ?? "{}") as Record<string, unknown>;
    return keys.some((key) => key in parsed);
  } catch {
    return false;
  }
}

function firstExisting(paths: Set<string>, candidates: string[]): string | undefined {
  return candidates.find((candidate) => paths.has(candidate));
}

function evidence(values: Array<string | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value));
}

function dedupeByName(
  patterns: AdvancedArchitecturePattern[]
): AdvancedArchitecturePattern[] {
  const seen = new Set<string>();
  const output: AdvancedArchitecturePattern[] = [];

  for (const pattern of patterns) {
    if (!seen.has(pattern.name)) {
      seen.add(pattern.name);
      output.push(pattern);
    }
  }

  return output;
}

function lineNumberAt(text: string, index: number): number {
  return text.slice(0, index).split(/\r?\n/).length;
}

function shouldReadText(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return (
    textExtensions.has(extension) ||
    textFileNames.has(path.basename(filePath)) ||
    !isBinaryPath(filePath)
  );
}

const textExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".py",
  ".java",
  ".gradle",
  ".kts",
  ".xml",
  ".md"
]);

const textFileNames = new Set([
  "requirements.txt",
  "package.json",
  "pyproject.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "angular.json"
]);
