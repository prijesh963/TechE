import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  ARTIFACT_DIRECTORY_NAMES,
  CURRENT_SCHEMA_VERSION,
  type SafetyPolicy,
  createTrustMetadata,
  ensureArtifactDirectories,
  getArtifactFilePath,
  parseJson,
  writeJsonFile
} from "@copilot-architect/shared";

import type { SafetyPolicyInitResult, SafetyPolicyValidationResult } from "./models.js";

export class SafetyPolicyService {
  async init(
    startPath = process.cwd(),
    overwrite = false
  ): Promise<SafetyPolicyInitResult> {
    const workspaceRoot = path.resolve(startPath);
    const policyPath = getArtifactFilePath(workspaceRoot, "policy");

    await ensureArtifactDirectories(workspaceRoot);

    if (!overwrite && (await fileExists(policyPath))) {
      return {
        policyPath,
        created: false,
        message: "policy.json already exists; left unchanged."
      };
    }

    await writeJsonFile(policyPath, createDefaultSafetyPolicy());

    return {
      policyPath,
      created: true,
      message: "policy.json template created."
    };
  }

  async load(startPath = process.cwd()): Promise<SafetyPolicy> {
    const workspaceRoot = path.resolve(startPath);
    const policyPath = getArtifactFilePath(workspaceRoot, "policy");

    if (!(await fileExists(policyPath))) {
      return createDefaultSafetyPolicy();
    }

    return parseJson<SafetyPolicy>(await readFile(policyPath, "utf8"));
  }

  async validate(startPath = process.cwd()): Promise<SafetyPolicyValidationResult> {
    const workspaceRoot = path.resolve(startPath);
    const policyPath = getArtifactFilePath(workspaceRoot, "policy");
    const errors: string[] = [];
    const warnings: string[] = [];
    let policy: SafetyPolicy;

    try {
      policy = await this.load(workspaceRoot);
    } catch (error) {
      return {
        ok: false,
        policyPath,
        policy: createDefaultSafetyPolicy(),
        errors: [
          `policy.json must be valid JSON: ${error instanceof Error ? error.message : String(error)}`
        ],
        warnings
      };
    }

    if (!policy.schemaVersion) {
      errors.push("policy.schemaVersion is required.");
    }

    if (!policy.id) {
      errors.push("policy.id is required.");
    }

    if (!Array.isArray(policy.blockedPatterns) || policy.blockedPatterns.length === 0) {
      errors.push("policy.blockedPatterns must contain at least one blocked pattern.");
    }

    if (!Array.isArray(policy.secretRedactionPatterns)) {
      errors.push("policy.secretRedactionPatterns must be an array.");
    }

    if (!Array.isArray(policy.allowedPatterns)) {
      errors.push("policy.allowedPatterns must be an array.");
    }

    if (
      !Array.isArray(policy.requiredApprovalGates) ||
      policy.requiredApprovalGates.length === 0
    ) {
      errors.push("policy.requiredApprovalGates must contain at least one gate.");
    }

    for (const pattern of [
      ...arrayOrEmpty(policy.blockedPatterns),
      ...arrayOrEmpty(policy.allowedPatterns),
      ...arrayOrEmpty(policy.secretRedactionPatterns)
    ]) {
      try {
        new RegExp(pattern);
      } catch {
        errors.push(`Invalid regular expression in policy: ${pattern}`);
      }
    }

    if (!policy.requireApprovalForHandoff) {
      warnings.push("Implementation handoff approval is not required by policy.");
    }

    if (!policy.requiredApprovalGates?.includes("handoff")) {
      warnings.push("Required approval gates do not include handoff.");
    }

    if (!policy.workspaceBoundaryRequired) {
      warnings.push("Workspace boundary checks are disabled by policy.");
    }

    if (policy.telemetryEnabled !== false) {
      warnings.push("Telemetry should stay disabled for the internal local-first MVP.");
    }

    if (policy.localFirst !== true) {
      warnings.push("Local-first operation is not explicitly required by policy.");
    }

    validateArtifactRetention(policy, errors, warnings);
    validateTrustMetadata(policy, errors, warnings);

    return {
      ok: errors.length === 0,
      policyPath,
      policy,
      errors,
      warnings
    };
  }
}

export function createDefaultSafetyPolicy(): SafetyPolicy {
  const now = new Date().toISOString();
  const trustMetadata = createTrustMetadata({
    artifactKind: "safety-policy",
    source: ".copilot-architect/policy.json"
  });

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    generatedAt: now,
    trust: trustMetadata,
    id: "default-safety-policy",
    name: "Default Safety Policy",
    defaultAllow: true,
    blockedPatterns: DEFAULT_BLOCKED_PATTERNS,
    allowedPatterns: [],
    secretRedactionPatterns: DEFAULT_SECRET_REDACTION_PATTERNS,
    requireApprovalForHandoff: true,
    workspaceBoundaryRequired: true,
    requiredApprovalGates: [
      "planning",
      "handoff",
      "validation-risk",
      "agent-install",
      "policy-change"
    ],
    telemetryEnabled: false,
    localFirst: true,
    artifactRetention: {
      enabled: true,
      maxAgeDays: 30,
      maxRuns: 50,
      directories: ["plans", "handoffs", "runs", "reviews", "diagnostics"],
      dryRunDefault: true
    },
    trustMetadata
  };
}

export const DEFAULT_BLOCKED_PATTERNS = [
  String.raw`\brm\s+-[^\s]*(?:r[^\s]*f|f[^\s]*r)`,
  String.raw`\bdel\s+\/s\b`,
  String.raw`^(?:format|format\.com)(?:\s|$)`,
  String.raw`\bdiskpart\b`,
  String.raw`\bgit\s+clean\b(?=.*-[^\s]*f)(?=.*-[^\s]*d)(?=.*-[^\s]*x)`,
  String.raw`\bgit\s+reset\s+--hard\b`,
  String.raw`\bchmod\s+-r\s+777\b`,
  String.raw`\bsudo\s+rm\b`,
  String.raw`\bRemove-Item\s+-Recurse\b`
];

export const DEFAULT_SECRET_REDACTION_PATTERNS = [
  // Generic env-var assignments containing sensitive keywords
  String.raw`\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|AUTH_KEY|PRIVATE_KEY|CLIENT_SECRET|SIGNING_KEY|ENCRYPTION_KEY)[A-Z0-9_]*)=([^\s]+)`,
  // HTTP Authorization header values
  String.raw`\bBearer\s+[A-Za-z0-9._~+/=-]+`,
  // GitHub personal access tokens and fine-grained tokens
  String.raw`\bgh[pousr]_[A-Za-z0-9_]+`,
  // AWS access key IDs (20-char uppercase alphanumeric starting with AKIA/ASIA/AROA)
  String.raw`\b(?:AKIA|ASIA|AROA|AIPA|ANPA|ANVA|APKA)[A-Z0-9]{16}\b`,
  // AWS secret access key (40-char base64-like string following the keyword)
  String.raw`(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*[A-Za-z0-9/+=]{40}`,
  // GCP service account / API key patterns
  String.raw`AIza[A-Za-z0-9_-]{35}`,
  // Stripe secret keys
  String.raw`\bsk_(?:live|test)_[A-Za-z0-9]{24,}`,
  // Stripe publishable keys (less sensitive but redact anyway)
  String.raw`\bpk_(?:live|test)_[A-Za-z0-9]{24,}`,
  // Stripe restricted keys
  String.raw`\brk_(?:live|test)_[A-Za-z0-9]{24,}`,
  // PEM private key blocks
  String.raw`-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----`,
  // JWT tokens (three base64url segments separated by dots)
  String.raw`\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`,
  // Generic high-entropy hex secrets (32+ hex chars) following known keywords
  String.raw`(?:secret|token|password|api_key|apikey)\s*[=:]\s*[0-9a-f]{32,}`,
  // Database connection strings
  String.raw`(?:postgres|mysql|mongodb|redis|mssql|sqlserver):\/\/[^\s@]*:[^\s@]+@`,
  // npm auth tokens
  String.raw`\b(?:_authToken|npm_token)\s*=\s*[A-Za-z0-9_-]{36,}`,
  // Slack tokens
  String.raw`\bxox[baprs]-[A-Za-z0-9-]+`
];

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath, "utf8");
    return true;
  } catch {
    return false;
  }
}

function arrayOrEmpty(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function validateArtifactRetention(
  policy: SafetyPolicy,
  errors: string[],
  warnings: string[]
): void {
  const retention = policy.artifactRetention;

  if (!retention || typeof retention !== "object") {
    errors.push("policy.artifactRetention is required.");
    return;
  }

  if (typeof retention.enabled !== "boolean") {
    errors.push("policy.artifactRetention.enabled must be a boolean.");
  }

  if (!Number.isFinite(retention.maxAgeDays) || retention.maxAgeDays < 0) {
    errors.push("policy.artifactRetention.maxAgeDays must be zero or greater.");
  }

  if (!Number.isInteger(retention.maxRuns) || retention.maxRuns < 1) {
    errors.push("policy.artifactRetention.maxRuns must be at least 1.");
  }

  if (!Array.isArray(retention.directories) || retention.directories.length === 0) {
    errors.push(
      "policy.artifactRetention.directories must contain at least one directory."
    );
  } else {
    const knownDirectories = new Set<string>(Object.values(ARTIFACT_DIRECTORY_NAMES));

    for (const directory of retention.directories) {
      if (typeof directory !== "string" || !knownDirectories.has(directory)) {
        errors.push(`Unknown artifact retention directory: ${String(directory)}.`);
      }
    }

    if (retention.directories.includes("audit")) {
      warnings.push(
        "Audit log retention is enabled; preserve compliance evidence intentionally."
      );
    }
  }

  if (typeof retention.dryRunDefault !== "boolean") {
    errors.push("policy.artifactRetention.dryRunDefault must be a boolean.");
  }
}

function validateTrustMetadata(
  policy: SafetyPolicy,
  errors: string[],
  warnings: string[]
): void {
  const trust = policy.trustMetadata;

  if (!trust || typeof trust !== "object") {
    errors.push("policy.trustMetadata is required.");
    return;
  }

  if (!trust.generatedBy) {
    errors.push("policy.trustMetadata.generatedBy is required.");
  }

  if (!trust.policyId) {
    errors.push("policy.trustMetadata.policyId is required.");
  } else if (trust.policyId !== policy.id) {
    warnings.push("policy.trustMetadata.policyId does not match policy.id.");
  }

  if (trust.telemetryEnabled !== policy.telemetryEnabled) {
    warnings.push(
      "policy.trustMetadata.telemetryEnabled does not match policy telemetry."
    );
  }

  if (trust.localOnly !== policy.localFirst) {
    warnings.push(
      "policy.trustMetadata.localOnly does not match policy local-first setting."
    );
  }
}
