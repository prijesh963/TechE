import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { collectSessionChangeStats } from "../packages/core/src/index.js";

const execFileAsync = promisify(execFile);

describe("collectSessionChangeStats", () => {
  it("reports zero changes when nothing changed since sinceIso", async () => {
    if (!(await gitAvailable())) {
      return;
    }

    const repoRoot = await createRepo({ "src/app.ts": "export const app = 1;\n" });
    await initializeGitRepo(repoRoot);
    const sinceIso = new Date().toISOString();

    const stats = await collectSessionChangeStats(repoRoot, sinceIso);

    expect(stats).toEqual({ filesChanged: 0, linesAdded: 0, linesRemoved: 0 });
  });

  it("counts added and removed lines in tracked files changed since sinceIso", async () => {
    if (!(await gitAvailable())) {
      return;
    }

    const repoRoot = await createRepo({
      "src/app.ts": "line one\nline two\nline three\n"
    });
    await initializeGitRepo(repoRoot);
    const sinceIso = new Date().toISOString();

    // A tracked file edited (not committed) during the session — collectSessionChangeStats
    // diffs against the working tree, so it must see this without a commit.
    await writeFile(
      path.join(repoRoot, "src/app.ts"),
      "line one\nline replaced\nline three\nline four\n",
      "utf8"
    );

    const stats = await collectSessionChangeStats(repoRoot, sinceIso);

    expect(stats).toBeDefined();
    expect(stats?.filesChanged).toBe(1);
    expect(stats?.linesAdded).toBe(2);
    expect(stats?.linesRemoved).toBe(1);
  });

  it("counts changes committed during the session, not just working-tree edits", async () => {
    if (!(await gitAvailable())) {
      return;
    }

    const repoRoot = await createRepo({ "src/app.ts": "export const app = 1;\n" });
    await initializeGitRepo(repoRoot);
    const sinceIso = new Date().toISOString();

    // Git commit dates have 1-second resolution. Without a real gap here, a
    // fast test run can land both commits in the same integer second, making
    // `--before sinceIso` ambiguous between them — not a bug in the function
    // under test, just a precision limit of second-granularity timestamps.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    await writeFile(
      path.join(repoRoot, "src/new-feature.ts"),
      "export const feature = true;\n",
      "utf8"
    );
    await commitAll(repoRoot, "add feature");

    const stats = await collectSessionChangeStats(repoRoot, sinceIso);

    // session.gitHead would read this as zero change (same branch, HEAD file
    // unchanged) — this is exactly the case the timestamp-based base commit
    // exists to catch instead.
    expect(stats?.filesChanged).toBe(1);
    expect(stats?.linesAdded).toBe(1);
  });

  it("returns undefined when there is no git repository", async () => {
    const repoRoot = await createRepo({ "src/app.ts": "export const app = 1;\n" });

    const stats = await collectSessionChangeStats(repoRoot, new Date().toISOString());

    expect(stats).toBeUndefined();
  });
});

async function createRepo(files: Record<string, string>): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "copilot-session-change-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }

  return repoRoot;
}

async function initializeGitRepo(repoRoot: string): Promise<void> {
  await execFileAsync("git", ["init"], { cwd: repoRoot });
  await commitAll(repoRoot, "initial");
}

async function commitAll(repoRoot: string, message: string): Promise<void> {
  await execFileAsync("git", ["add", "."], { cwd: repoRoot });
  await execFileAsync(
    "git",
    [
      "-c",
      "user.name=Copilot Architect",
      "-c",
      "user.email=copilot-architect@example.test",
      "commit",
      "-m",
      message
    ],
    { cwd: repoRoot }
  );
}

async function gitAvailable(): Promise<boolean> {
  try {
    await execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}
