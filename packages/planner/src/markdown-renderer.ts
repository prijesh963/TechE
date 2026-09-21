import type { CrossRepoInterlink } from "@copilot-architect/shared";

import type { FeaturePlanArtifact, PlanRevisionEntry } from "./models.js";

export function renderFeaturePlanMarkdown(plan: FeaturePlanArtifact): string {
  return [
    `# ${plan.title}`,
    "",
    `**Status:** ${plan.status}`,
    `**Revision:** ${plan.revision}`,
    `**Requires human approval:** ${plan.requiresHumanApproval ? "yes" : "no"}`,
    "",
    "## Revision History",
    renderRevisionHistory(plan.revisions),
    "",
    "## Request Interpretation",
    plan.requestInterpretation,
    `Classified as **${plan.requestIntent}** intent (entities: ${plan.requestEntities.join(", ") || "none"}).`,
    "",
    "## Repo Architecture Summary",
    plan.repoArchitectureSummary,
    "",
    "## Planning Context",
    renderBullets([
      `Workspace repo roots: ${plan.planningContext.workspaceRepoRoots.join(", ") || "current repo"}`,
      `Custom commands: ${plan.planningContext.customCommandNames.join(", ") || "none detected"}`,
      `Instruction files: ${plan.planningContext.instructionFiles.join(", ") || "none detected"}`
    ]),
    "",
    "## Relevant Files",
    renderFileReferences(plan.relevantFiles),
    "",
    "## Similar Feature Candidates",
    renderFileReferences(plan.similarFeatureCandidates),
    "",
    "## Impacted Languages And Frameworks",
    renderBullets([
      `Languages: ${plan.impactedLanguages.join(", ") || "unknown"}`,
      `Frameworks: ${plan.impactedFrameworks.join(", ") || "none detected"}`
    ]),
    "",
    "## Impacted Modules And Folders",
    renderBullets(plan.impactedModules),
    "",
    "## Advanced Architecture Signals",
    renderBullets(
      plan.advancedAnalysis.architecturePatterns.map(
        (pattern) =>
          `${withRepoPrefix(pattern.repoName)}${pattern.name} (${pattern.confidence}): ${pattern.evidence.join(", ")}`
      )
    ),
    "",
    "## Detected Routes And APIs",
    renderBullets(
      plan.advancedAnalysis.routes.map(
        (route) =>
          `${withRepoPrefix(route.repoName)}${route.kind} ${route.method} ${route.routePath} in \`${route.filePath}\``
      )
    ),
    "",
    "## Test Relationships",
    renderBullets(
      plan.advancedAnalysis.testRelationships.slice(0, 12).map((relationship) => {
        const prefix = withRepoPrefix(relationship.repoName);
        return relationship.testFile
          ? `${prefix}${relationship.kind}: \`${relationship.sourceFile}\` -> \`${relationship.testFile}\``
          : `${prefix}${relationship.kind}: \`${relationship.sourceFile}\` has no nearby test`;
      })
    ),
    "",
    "## Cross-Repo Interlinks",
    renderBullets(plan.advancedAnalysis.interlinks.map(describeInterlink)),
    "",
    "## Endpoints To Touch",
    renderBullets(
      plan.relatedEndpoints.map((endpoint) => {
        const location = endpoint.line
          ? `${endpoint.filePath}:${endpoint.line}`
          : endpoint.filePath;
        const test = endpoint.testFile
          ? `test \`${endpoint.testFile}\``
          : "no nearby test";
        return `${endpoint.method} ${endpoint.routePath} (\`${location}\`) - ${test}`;
      })
    ),
    "",
    "## Likely Files To Modify",
    renderBullets(plan.likelyFilesToModify),
    "",
    "## Likely New Files",
    renderBullets(plan.likelyNewFiles),
    "",
    "## Frontend/UI Impact",
    renderBullets(plan.frontendImpact),
    "",
    "## Backend/API Impact",
    renderBullets(plan.backendImpact),
    "",
    "## Data/Config Impact",
    renderBullets(plan.dataConfigImpact),
    "",
    "## Security Considerations",
    renderBullets(plan.securityConsiderations),
    "",
    "## Performance Considerations",
    renderBullets(plan.performanceConsiderations),
    "",
    "## Test Strategy",
    renderBullets(plan.testStrategy),
    "",
    "## Validation Commands",
    renderBullets(
      plan.validationPlan.commands.map((command) =>
        [command.command, ...command.args].join(" ")
      )
    ),
    "",
    "## Risk Scores",
    renderBullets(
      plan.riskScores.map(
        (risk) =>
          `${risk.category}: ${risk.level} (${risk.score}/100). ${risk.reasons.join(" ")}`
      )
    ),
    "",
    "## Plan Quality",
    renderBullets([
      `Score: ${plan.planQuality.score}/100 (${plan.planQuality.level} risk)`,
      ...plan.planQuality.checks.map(
        (check) =>
          `${check.name}: ${check.passed ? "passed" : "needs attention"} - ${check.details}`
      ),
      ...plan.planQuality.warnings.map((warning) => `Warning: ${warning}`)
    ]),
    "",
    "## Repo Readiness Diagnostics",
    renderBullets(
      plan.readinessDiagnostics.map(
        (diagnostic) =>
          `${diagnostic.severity}: ${diagnostic.code} - ${diagnostic.message}${
            diagnostic.recommendation
              ? ` Recommendation: ${diagnostic.recommendation}`
              : ""
          }`
      )
    ),
    "",
    "## Step-by-Step Implementation Plan",
    renderNumbered(
      plan.implementationSteps.map((step) => `${step.title}: ${step.details}`)
    ),
    "",
    "## Stack-Specific Plan",
    renderStackSpecificPlan(plan),
    "",
    "## Risks",
    renderBullets(
      plan.impactAnalysis.risks.map((risk) =>
        risk.mitigation
          ? `${risk.title}: ${risk.details} Mitigation: ${risk.mitigation}`
          : `${risk.title}: ${risk.details}`
      )
    ),
    "",
    "## Assumptions",
    renderBullets(plan.assumptions),
    "",
    "## Open Questions",
    renderBullets(plan.openQuestions),
    "",
    "## Human Approval Checkpoint",
    plan.humanApprovalCheckpoint,
    ""
  ].join("\n");
}

function renderRevisionHistory(revisions: PlanRevisionEntry[]): string {
  if (revisions.length === 0) {
    return "- None recorded yet.";
  }

  return revisions
    .map(
      (entry) =>
        `- rev ${entry.revision} (${entry.source}, ${entry.at}): ${entry.feedback}`
    )
    .join("\n");
}

function renderFileReferences(files: { filePath: string; reason: string }[]): string {
  if (files.length === 0) {
    return "- None identified yet.";
  }

  return files.map((file) => `- \`${file.filePath}\`: ${file.reason}`).join("\n");
}

function renderBullets(values: string[]): string {
  if (values.length === 0) {
    return "- None identified yet.";
  }

  return values.map((value) => `- ${value}`).join("\n");
}

// Absent for single-repo analysis, so a single-repo plan reads unchanged.
function withRepoPrefix(repoName: string | undefined): string {
  return repoName ? `${repoName}: ` : "";
}

function describeInterlink(interlink: CrossRepoInterlink): string {
  if (interlink.kind === "messaging") {
    return `${interlink.fromRepo} produces to ${interlink.method} "${interlink.path}" (\`${interlink.fromFile}\`) -> ${interlink.toRepo} consumes it (\`${interlink.toFile}\`) [${interlink.confidence}]`;
  }

  return `${interlink.fromRepo} calls ${interlink.method} ${interlink.path} (\`${interlink.fromFile}\`) -> ${interlink.toRepo} (\`${interlink.toFile}\`) [${interlink.confidence}]`;
}

function renderNumbered(values: string[]): string {
  if (values.length === 0) {
    return "1. No implementation steps identified yet.";
  }

  return values.map((value, index) => `${index + 1}. ${value}`).join("\n");
}

function renderStackSpecificPlan(plan: FeaturePlanArtifact): string {
  return [
    "### React",
    renderBullets(plan.stackSpecificPlan.react),
    "",
    "### Angular",
    renderBullets(plan.stackSpecificPlan.angular),
    "",
    "### Python",
    renderBullets(plan.stackSpecificPlan.python),
    "",
    "### Java",
    renderBullets(plan.stackSpecificPlan.java),
    "",
    "### Integrations",
    renderBullets(plan.stackSpecificPlan.integrations),
    "",
    "### Generic",
    renderBullets(plan.stackSpecificPlan.generic)
  ].join("\n");
}
