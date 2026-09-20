#!/usr/bin/env node
/**
 * Builds an installable `.vsix` from the bundled extension.
 *
 * Why this stages a copy rather than running `vsce` over the workspace
 * package directly:
 *
 * - A VSIX identifier must match `^[a-z0-9][a-z0-9-]*$`, and the workspace
 *   package is scoped (`@copilot-architect/vscode-extension`). Renaming it in
 *   place would break every workspace reference.
 * - `vsce` would otherwise walk `node_modules` for five workspace
 *   dependencies that are already inside the bundle, producing a package
 *   containing each of them twice.
 * - The staged manifest points `main` at the bundled CommonJS entry point,
 *   while the workspace manifest keeps pointing at the `tsc` output the tests
 *   and other packages import.
 *
 * Usage: npm run package:vsix
 */

import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionDir = path.join(rootDir, "packages", "vscode-extension");
const bundleDir = path.join(extensionDir, "bundle");
const stageDir = path.join(rootDir, "dist-vsix", "stage");
const outDir = path.join(rootDir, "dist-vsix");

run("node", [path.join(rootDir, "scripts", "bundle-extension.mjs")]);

for (const required of ["extension.cjs", "cli.mjs"]) {
  if (!existsSync(path.join(bundleDir, required))) {
    throw new Error(`Bundle is missing ${required} — did the bundler fail?`);
  }
}

await rm(stageDir, { recursive: true, force: true });
await mkdir(stageDir, { recursive: true });

// Old packages are removed, not left beside the new one.
//
// The version rising per commit only tells a developer which build they are
// running if they install the one they meant to. This directory accumulated
// every build ever made — including 0.1.0, from before the version meant
// anything — and an install dialog listing five of them is an invitation to
// pick the wrong one. It has already happened: a fix verified in the
// repository was reported broken in the editor, from a build two versions
// behind.
for (const entry of existsSync(outDir) ? await readdir(outDir) : []) {
  if (entry.endsWith(".vsix")) {
    await rm(path.join(outDir, entry), { force: true });
  }
}

const manifest = JSON.parse(
  await readFile(path.join(extensionDir, "package.json"), "utf8")
);

/**
 * A version that changes with the code.
 *
 * Every build shipped as 0.1.0, so VS Code had no reason to think an
 * installed extension differed from a new one — and a developer re-testing a
 * fix had no way to tell which build was actually running. A fix verified in
 * the repository looked broken in the editor, twice, because the old bundle
 * was still there.
 *
 * The patch number is the commit count, so it rises with every commit and is
 * the same for everyone building the same tree.
 */
const buildInfo = describeBuild(rootDir, manifest.version);

const staged = {
  name: "copilot-architect",
  displayName: manifest.displayName,
  description: manifest.description,
  version: buildInfo.version,
  publisher: manifest.publisher,
  // Carried into the package because the README is docs/INSTALL.md, which
  // links to the repository's Releases page by relative path. `vsce` resolves
  // those against the declared repository and refuses to package when it
  // cannot — a broken link in an installed extension is a dead end for
  // whoever is trying to find the next build.
  repository: manifest.repository,
  license: "SEE LICENSE IN README.md",
  categories: manifest.categories,
  engines: manifest.engines,
  // The bundle is CommonJS, which the extension host requires. Declaring no
  // `type` keeps `.cjs` and `.mjs` meaning exactly what their extensions say.
  main: "./extension.cjs",
  activationEvents: manifest.activationEvents,
  contributes: manifest.contributes
};

await writeFile(
  path.join(stageDir, "package.json"),
  `${JSON.stringify(staged, null, 2)}\n`,
  "utf8"
);

// Source maps stay in `bundle/` for local debugging but are left out of the
// package: the CLI's map alone is larger than everything else combined.
await copyFile(
  path.join(bundleDir, "extension.cjs"),
  path.join(stageDir, "extension.cjs")
);
await copyFile(path.join(bundleDir, "cli.mjs"), path.join(stageDir, "cli.mjs"));

await mkdir(path.join(stageDir, "resources"), { recursive: true });
await copyFile(
  path.join(extensionDir, "resources", "copilot-architect.svg"),
  path.join(stageDir, "resources", "copilot-architect.svg")
);

await copyFile(
  path.join(rootDir, "docs", "INSTALL.md"),
  path.join(stageDir, "README.md")
);

// The staging directory holds only what belongs in the package, so this
// excludes nothing — it exists so `vsce` does not warn that an unbounded
// directory is being packaged.
await writeFile(
  path.join(stageDir, ".vscodeignore"),
  "# Staged by scripts/package-vsix.mjs; every file here is intentional.\n",
  "utf8"
);

const vsixPath = path.join(outDir, `copilot-architect-${staged.version}.vsix`);
run("npx", ["vsce", "package", "--no-dependencies", "--out", vsixPath], stageDir);

console.log(`\nVSIX: ${path.relative(rootDir, vsixPath)}`);
console.log(`Build: ${buildInfo.version} (${buildInfo.commit})`);
console.log("Install with: code --install-extension <path>, or");
console.log("VS Code > Extensions > ... > Install from VSIX...");

/**
 * Version and commit for this build.
 *
 * Falls back to the manifest version outside a git checkout — a ZIP download
 * has no history, and refusing to package there would break the path most
 * teammates use.
 */
function describeBuild(root, baseVersion) {
  const [major, minor] = baseVersion.split(".");
  const git = (args) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout?.trim();

  const count = git(["rev-list", "--count", "HEAD"]);
  const commit = git(["rev-parse", "--short", "HEAD"]);

  return count && commit
    ? { version: `${major}.${minor}.${count}`, commit }
    : { version: baseVersion, commit: "no git history" };
}

function run(command, args, cwd = rootDir) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", shell: false });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status})`);
  }
}
