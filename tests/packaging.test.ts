import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../packages/cli/src/index.js";

function createCapture() {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    io: {
      stdout: (message: string) => stdout.push(message),
      stderr: (message: string) => stderr.push(message)
    }
  };
}

describe("Phase 23 internal packaging", () => {
  it("ships local packaging scripts and internal setup docs", async () => {
    const root = process.cwd();

    await expect(
      access(path.join(root, "scripts", "package-local.mjs"))
    ).resolves.toBeUndefined();
    await expect(access(path.join(root, ".npmignore"))).resolves.toBeUndefined();
    await expect(
      access(path.join(root, "docs", "INSTALLATION.md"))
    ).resolves.toBeUndefined();
    await expect(
      access(path.join(root, "docs", "INTERNAL_TEAM_SETUP.md"))
    ).resolves.toBeUndefined();
    await expect(
      access(path.join(root, "docs", "TROUBLESHOOTING.md"))
    ).resolves.toBeUndefined();
    await expect(
      access(path.join(root, "docs", "UPGRADE_GUIDE.md"))
    ).resolves.toBeUndefined();
    await expect(access(path.join(root, "CHANGELOG.md"))).resolves.toBeUndefined();

    const packageJson = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8")
    );
    expect(packageJson.scripts["package:local"]).toBe("node scripts/package-local.mjs");
  });

  it("documents clone, npm link, tarball, troubleshooting, and upgrade workflows", async () => {
    const root = process.cwd();
    const installation = await readFile(
      path.join(root, "docs", "INSTALLATION.md"),
      "utf8"
    );
    const teamSetup = await readFile(
      path.join(root, "docs", "INTERNAL_TEAM_SETUP.md"),
      "utf8"
    );
    const troubleshooting = await readFile(
      path.join(root, "docs", "TROUBLESHOOTING.md"),
      "utf8"
    );
    const upgrade = await readFile(path.join(root, "docs", "UPGRADE_GUIDE.md"), "utf8");

    expect(installation).toContain("npm run package:local");
    expect(installation).toContain("npm link");
    expect(teamSetup).toContain("New Team Member Setup");
    expect(troubleshooting).toContain("npm run cli -- doctor");
    expect(upgrade).toContain("npm run cli -- version");
  });

  it("reports version and packaging readiness through CLI commands", async () => {
    const versionCapture = createCapture();
    const doctorCapture = createCapture();

    expect((await runCli(["version"], versionCapture.io)).exitCode).toBe(0);
    expect((await runCli(["doctor", "--json"], doctorCapture.io)).exitCode).toBe(0);

    const doctor = JSON.parse(doctorCapture.stdout.join("\n"));

    expect(versionCapture.stdout.join("\n")).toContain("Copilot Architect 0.1.0");
    expect(doctor.status).toBe("ok");
    expect(doctor.checks.map((check: { name: string }) => check.name)).toContain(
      "local-package"
    );
  });
});

describe("publishing the VSIX", () => {
  const workflowPath = path.join(
    process.cwd(),
    ".github",
    "workflows",
    "release-vsix.yml"
  );

  it("ships a workflow that builds and publishes the package", async () => {
    // The distribution model is a download link: a teammate needs VS Code and
    // Copilot, not a clone, Node and npm. The `.vsix` is gitignored — it is
    // derived bytes that change every commit — so something has to build it.
    await expect(access(workflowPath)).resolves.toBeUndefined();

    const workflow = await readFile(workflowPath, "utf8");
    expect(workflow).toContain("npm run package:vsix");
    expect(workflow).toContain("gh release create");
  });

  it("checks out full history so the build number is real", async () => {
    // `describeBuild` stamps the version from `git rev-list --count HEAD`.
    // A default shallow checkout would make that 1, so every release would
    // publish 0.1.1 — silently, and forever. The build number is the only
    // thing that tells a developer whether the extension they installed is
    // the one they think it is, and a wrong one is worse than none.
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toMatch(/fetch-depth:\s*0/);
  });

  it("refuses to publish a build that did not pass the checks", async () => {
    // This job produces the file people install. A red build must not become
    // a download link, so the gates run here rather than being assumed from
    // the CI job.
    const workflow = await readFile(workflowPath, "utf8");
    const packageStep = workflow.indexOf("npm run package:vsix");

    for (const gate of ["npm run lint", "npm run build", "npm test"]) {
      const at = workflow.indexOf(gate);
      expect(at).toBeGreaterThan(-1);
      expect(at).toBeLessThan(packageStep);
    }
  });

  it("fails rather than guess when more than one package is present", async () => {
    // A glob matching two files would write a multi-line value into
    // GITHUB_OUTPUT and publish whichever the shell ended on — the exact
    // wrong-version failure the build number exists to prevent.
    const workflow = await readFile(workflowPath, "utf8");

    expect(workflow).toContain("Expected exactly one .vsix");
  });

  it("clears stale packages so the newest is the only one offered", async () => {
    // dist-vsix accumulated every build ever made, including 0.1.0 from
    // before the version meant anything. An install dialog listing five is an
    // invitation to pick the wrong one, which has already happened.
    const script = await readFile(
      path.join(process.cwd(), "scripts", "package-vsix.mjs"),
      "utf8"
    );

    expect(script).toContain('entry.endsWith(".vsix")');
  });
});

describe("the packaged README", () => {
  it("declares a repository, because INSTALL.md links by relative path", async () => {
    // docs/INSTALL.md is copied into the package as its README, and points at
    // the Releases page with `../../releases`. `vsce` resolves relative links
    // against the declared repository and refuses to package without one, so
    // these two facts have to stay true together. They did not: the link was
    // added and the manifest was not, and packaging failed on the first
    // release run.
    const install = await readFile(
      path.join(process.cwd(), "docs", "INSTALL.md"),
      "utf8"
    );
    const relativeLinks = install.match(/\]\((?!https?:|#)[^)]+\)/g) ?? [];

    if (relativeLinks.length === 0) {
      return;
    }

    const manifest = JSON.parse(
      await readFile(
        path.join(process.cwd(), "packages", "vscode-extension", "package.json"),
        "utf8"
      )
    );

    expect(manifest.repository?.url).toMatch(/^https:\/\/github\.com\//);
  });

  it("packages without suppressing the missing-repository check", async () => {
    // The flag existed to quiet a warning about a real gap. The gap is closed,
    // so keeping the flag would only hide the next one.
    const script = await readFile(
      path.join(process.cwd(), "scripts", "package-vsix.mjs"),
      "utf8"
    );

    expect(script).not.toContain("--allow-missing-repository");
    expect(script).toContain("repository: manifest.repository");
  });
});
