import path from "node:path";

import { describe, expect, it } from "vitest";

import { cliInvocation, getCommandHelpText } from "../packages/cli/src/index.js";

describe("the invocation the help text names", () => {
  it("names the bundled file when that is what is running", () => {
    // The CLI ships inside the VSIX and is spawned by absolute path on a
    // machine with no package.json and no clone. Printing `npm run cli --`
    // there sends a developer to type something that cannot work — the same
    // mistake Phase 7 fixed for the extension's spawn path.
    const bundled = path.join("/opt", "ext", "bundle", "cli.mjs");

    expect(cliInvocation(bundled)).toBe(`node ${bundled}`);
  });

  it("keeps the npm script when running from the workspace sources", () => {
    // The one place the script actually exists.
    const source = path.join("/home", "dev", "packages", "cli", "src", "index.ts");

    expect(cliInvocation(source)).toBe("npm run cli --");
  });

  it("names the command itself when installed as a bin", () => {
    expect(cliInvocation(path.join("/usr", "local", "bin", "copilot-architect"))).toBe(
      "copilot-architect"
    );
  });

  it("falls back rather than printing an empty command", () => {
    expect(cliInvocation("")).toBe("npm run cli --");
  });

  it("does not name a host that merely imported the CLI", () => {
    // The CLI is imported as a library too — by the test runner, and by
    // anything embedding it. A first version printed whatever script was
    // running, telling a reader to type `node .../vitest/forks.js init`.
    expect(cliInvocation("/repo/node_modules/vitest/dist/workers/forks.js")).toBe(
      "npm run cli --"
    );
    expect(cliInvocation("/usr/bin/some-other-tool")).toBe("npm run cli --");
  });
});

describe("plan approve discoverability", () => {
  it("documents the subcommand in the command's own help", () => {
    // It existed, worked, and appeared nowhere: the only way to find it was
    // an error message from a different command.
    const help = getCommandHelpText("plan");

    expect(help).toContain("plan approve");
    expect(help).toContain("--revision");
    expect(help).toContain("--by");
  });
});
