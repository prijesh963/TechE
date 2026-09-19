import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const workspaceRoot = process.cwd();

const lockedMvpCapabilities = [
  "TypeScript CLI.",
  "Repo discovery.",
  "JS/TS adapter.",
  "React adapter.",
  "Angular adapter.",
  "Python adapter.",
  "Java adapter.",
  "Generic adapter.",
  "Local indexing.",
  "Search.",
  "Feature planning.",
  "Custom command config.",
  "Validation engine.",
  "Safety policy.",
  "MCP server.",
  "Custom Copilot agents.",
  "Copilot instructions.",
  "Handoff prompts.",
  "Review reports.",
  "Multi-repo workspace basics.",
  "Basic VS Code extension shell.",
  "Internal setup docs."
] as const;

const mvpNonGoals = [
  "Full autonomous code editing inside this tool.",
  "Commercial distribution.",
  // Not the VS Code .vsix, which ships. See MVP_DEFINITION.md.
  "Visual Studio (the IDE) extensions",
  "Cloud sync.",
  "Team dashboard.",
  "Heavy vector database.",
  "Perfect support for every framework.",
  "PR automation."
] as const;

describe("Phase 24 MVP definition and lock", () => {
  it("documents the locked MVP capability list", async () => {
    const mvp = await readMvpDefinition();

    for (const capability of lockedMvpCapabilities) {
      expect(mvp).toContain(capability);
    }

    expect(mvp).toContain("The MVP includes exactly these required capabilities:");
    expect(mvp).toContain(
      "Copilot Chat support is delivered through the locked MVP surfaces above"
    );
  });

  it("documents explicit MVP non-goals and boundary rules", async () => {
    const mvp = await readMvpDefinition();

    for (const nonGoal of mvpNonGoals) {
      expect(mvp).toContain(nonGoal);
    }

    expect(mvp).toContain("The MVP is not a .NET product");
    expect(mvp).toContain("does not include a Visual Studio VSIX");
    expect(mvp).toContain("Do not add new major product scope");
    expect(mvp).toContain("Do not claim perfect framework support");
  });

  it("locks the MVP evidence gates and e2e test path", async () => {
    const mvp = await readMvpDefinition();
    const readme = await readFile(path.join(workspaceRoot, "README.md"), "utf8");
    const testingStrategy = await readFile(
      path.join(workspaceRoot, "docs", "TESTING_STRATEGY.md"),
      "utf8"
    );

    for (const command of [
      "npm run format",
      "npm run lint",
      "npm run build",
      "npm test",
      "npm run cli -- doctor",
      "npm run cli -- version"
    ]) {
      expect(mvp).toContain(command);
    }

    expect(mvp).toContain("tests/sample-matrix.test.ts");
    expect(testingStrategy).toContain("MVP definition tests");
    expect(readme).toContain("docs/MVP_DEFINITION.md");
  });
});

async function readMvpDefinition(): Promise<string> {
  return readFile(path.join(workspaceRoot, "docs", "MVP_DEFINITION.md"), "utf8");
}
