#!/usr/bin/env node
/**
 * Bundles the VS Code extension into a self-contained CommonJS build.
 *
 * Two problems make this necessary rather than optional.
 *
 * The monorepo is ESM (`"type": "module"`, `module: NodeNext`), and the VS Code
 * extension host expects a CommonJS entry point. esbuild reads the ESM sources
 * and emits CJS, so nothing about how the code is written has to change.
 *
 * And the extension used to reach the CLI by spawning `npm run cli --`, which
 * only resolves when the working directory is this monorepo. On a teammate's
 * machine there is no package.json with a `cli` script, so a packaged extension
 * could not run a single command. The CLI is therefore bundled alongside the
 * extension and invoked by absolute path from inside the installed extension —
 * no npm, no monorepo, nothing to resolve on the user's disk.
 *
 * Usage: npm run build && node scripts/bundle-extension.mjs
 */

import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionDir = path.join(rootDir, "packages", "vscode-extension");
const outDir = path.join(extensionDir, "bundle");

const shared = {
  bundle: true,
  platform: "node",
  // Matches the `engines.vscode` floor; VS Code 1.90 ships Node 20.
  target: "node20",
  format: "cjs",
  sourcemap: true,
  logLevel: "info"
};

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await build({
  ...shared,
  entryPoints: [path.join(extensionDir, "src", "index.ts")],
  outfile: path.join(outDir, "extension.cjs"),
  // Provided by the host at runtime and never resolvable at build time.
  external: ["vscode"],
  // The sources are ESM and use `import.meta.url` to locate the bundled CLI
  // and to `createRequire("vscode")`. CommonJS has no `import.meta`, and
  // esbuild leaves it empty — which would silently resolve the CLI path
  // against the process working directory instead of failing loudly. Rebuild
  // the same value from `__filename`, which CJS does have.
  banner: {
    js: "const __moduleUrl = require('node:url').pathToFileURL(__filename).href;"
  },
  define: { "import.meta.url": "__moduleUrl" }
});

// The CLI stays ESM. It is spawned as its own process, so its module format
// is independent of the host's — and it uses top-level await, which CommonJS
// cannot express. Only the extension entry point has to be CJS.
await build({
  ...shared,
  format: "esm",
  // The CLI source already carries its own shebang, which esbuild preserves.
  entryPoints: [path.join(rootDir, "packages", "cli", "src", "index.ts")],
  outfile: path.join(outDir, "cli.mjs"),
  // The TypeScript compiler — pulled in for the symbol graph — is CommonJS and
  // calls `require("fs")` at runtime. An ESM bundle has no `require`, so
  // esbuild's shim throws "Dynamic require of fs is not supported". That shim
  // uses the ambient `require` when one exists, so providing one is enough.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __dirnameOf } from 'node:path';",
      "const require = __createRequire(import.meta.url);",
      // TypeScript also reads `__filename` — it swaps the case of its own
      // path to find out whether the filesystem is case-sensitive.
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __dirnameOf(__filename);"
    ].join("\n")
  }
});

console.log(`\nBundled to ${path.relative(rootDir, outDir)}/`);
console.log("  extension.cjs  — the extension host entry point");
console.log("  cli.mjs        — spawned by the extension, no npm required");
