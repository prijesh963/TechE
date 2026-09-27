#!/usr/bin/env node
/**
 * Bundles the CLI into a self-contained ESM build, independent of the VS
 * Code extension's own bundle.
 *
 * The IntelliJ plugin needs the exact same portable CLI the VS Code
 * extension already bundles (`npm run cli -- mcp` with no npm, no monorepo,
 * nothing to resolve on the user's disk) — but coupling the plugin's build
 * to `packages/vscode-extension/bundle/` would make an unrelated change to
 * the VS Code packaging pipeline able to break IntelliJ packaging, or vice
 * versa. This duplicates the small, already-proven esbuild config from
 * `bundle-extension.mjs` rather than share it, so the two release
 * pipelines stay independent.
 *
 * Usage: npm run build && node scripts/bundle-cli.mjs
 */

import { build } from "esbuild";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const outDir = path.join(rootDir, "dist-cli");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// Same shim as bundle-extension.mjs's CLI target: TypeScript (pulled in for
// the symbol graph) is CommonJS and calls `require("fs")` at runtime, which
// an ESM bundle has no ambient `require` for without this.
await build({
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: true,
  logLevel: "info",
  entryPoints: [path.join(rootDir, "packages", "cli", "src", "index.ts")],
  outfile: path.join(outDir, "cli.mjs"),
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __dirnameOf } from 'node:path';",
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __dirnameOf(__filename);"
    ].join("\n")
  }
});

// Grammars beside the bundle, same reason as bundle-extension.mjs: the
// indexer resolves them relative to the running script, and only Go/Rust
// measured zero symbols without them — silence, not an error, so a missing
// grammar here would not announce itself until someone asked about a Go
// file and got nothing back.
const grammarOut = path.join(outDir, "grammars");
await mkdir(grammarOut, { recursive: true });

const grammarSources = [
  ["node_modules/web-tree-sitter", "tree-sitter.wasm"],
  ["node_modules/tree-sitter-wasms/out", "tree-sitter-go.wasm"],
  ["node_modules/tree-sitter-wasms/out", "tree-sitter-rust.wasm"]
];

let grammarBytes = 0;
for (const [dir, file] of grammarSources) {
  const from = path.join(rootDir, dir, file);
  if (!existsSync(from)) {
    throw new Error(
      `Missing ${file} in ${dir}. Symbol parsing would silently fall back to ` +
        `patterns for every Go and Rust file in a packaged CLI.`
    );
  }
  await copyFile(from, path.join(grammarOut, file));
  grammarBytes += statSync(from).size;
}

console.log(`\nBundled to ${path.relative(rootDir, outDir)}/`);
console.log("  cli.mjs        — spawned by the IntelliJ plugin, no npm required");
console.log(
  `  grammars/      — ${grammarSources.length} wasm files, ` +
    `${(grammarBytes / 1024 / 1024).toFixed(1)} MB, for Go and Rust symbols`
);
