import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  isBinaryContent,
  isTestFile,
  scanRepository
} from "../packages/shared/src/index.js";

describe("scanRepository", () => {
  it("skips the built-in ignore set", async () => {
    const root = await createRepo({
      "src/app.ts": "export const app = true;",
      "node_modules/pkg/index.js": "module.exports = {};",
      "dist/bundle.js": "console.log('built');",
      "__pycache__/cache.pyc": "binary"
    });

    const paths = (await scanRepository(root)).map((entry) => entry.relativePath);

    expect(paths).toContain("src/app.ts");
    expect(paths).not.toContain("node_modules/pkg/index.js");
    expect(paths).not.toContain("dist/bundle.js");
    expect(paths).not.toContain("__pycache__/cache.pyc");
  });

  it("honors a root .gitignore including globs, anchors, and negation", async () => {
    const root = await createRepo({
      ".gitignore": [
        "*.log",
        "secrets/",
        "/build-output",
        "generated/**",
        "!generated/keep.ts"
      ].join("\n"),
      "src/app.ts": "export const app = true;",
      "debug.log": "noise",
      "secrets/.env": "TOKEN=abc",
      "build-output/main.js": "built",
      "generated/skip.ts": "export const skip = true;",
      "generated/keep.ts": "export const keep = true;"
    });

    const paths = (await scanRepository(root)).map((entry) => entry.relativePath);

    expect(paths).toContain("src/app.ts");
    expect(paths).not.toContain("debug.log");
    expect(paths).not.toContain("secrets/.env");
    expect(paths).not.toContain("build-output/main.js");
    expect(paths).not.toContain("generated/skip.ts");
    // Negation re-includes a specific file that an earlier rule excluded.
    expect(paths).toContain("generated/keep.ts");
  });

  it("can be told to ignore .gitignore", async () => {
    const root = await createRepo({
      ".gitignore": "*.log",
      "debug.log": "noise"
    });

    const withGitignore = (await scanRepository(root)).map(
      (entry) => entry.relativePath
    );
    const withoutGitignore = (
      await scanRepository(root, { respectGitignore: false })
    ).map((entry) => entry.relativePath);

    expect(withGitignore).not.toContain("debug.log");
    expect(withoutGitignore).toContain("debug.log");
  });
});

async function createRepo(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "copilot-scan-"));

  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, contents, "utf8");
  }

  return root;
}

describe("isTestFile", () => {
  it("recognizes a root-level test folder, not only a nested one", () => {
    // A repo-relative path to a root-level test folder has no leading
    // slash (`test/foo.ts`, not `/test/foo.ts`), so a naive
    // `path.includes("/test/")` silently missed every file living directly
    // in one — this was four separate, disagreeing implementations before
    // being consolidated here, and this was the bug all four shared.
    expect(isTestFile("test/login.ts")).toBe(true);
    expect(isTestFile("tests/login.ts")).toBe(true);
    expect(isTestFile("spec/login.ts")).toBe(true);
    expect(isTestFile("__tests__/login.ts")).toBe(true);
    // Nested still works, unaffected.
    expect(isTestFile("src/test/login.ts")).toBe(true);
  });

  it("recognizes a Cucumber/Gherkin feature file", () => {
    // The extension alone is unambiguous — nothing else uses `.feature` —
    // so this works even without the folder fix above.
    expect(isTestFile("features/login.feature")).toBe(true);
    expect(isTestFile("login.feature")).toBe(true);
    // A step-definition file is not itself a feature file.
    expect(isTestFile("src/steps/LoginSteps.java")).toBe(false);
  });

  it("recognizes standard .test./.spec. naming and a test_ prefix", () => {
    expect(isTestFile("e2e/login.spec.ts")).toBe(true);
    expect(isTestFile("src/App.test.tsx")).toBe(true);
    expect(isTestFile("tests/test_login.py")).toBe(true);
  });

  it("recognizes JUnit/TestNG's Tests.java suffix convention", () => {
    // `SomethingTests.java` has no `.test.` separator for the generic name
    // check to catch.
    expect(isTestFile("src/UserServiceTests.java")).toBe(true);
    expect(isTestFile("src/UserService.java")).toBe(false);
  });

  it("does not flag an ordinary file whose name merely contains 'test'", () => {
    // A looser, path-wide "test_" check (one of the four disagreeing
    // implementations had this) false-positived on this exact input.
    expect(isTestFile("contest_entry.py")).toBe(false);
    expect(isTestFile("src/index.ts")).toBe(false);
  });
});

describe("isBinaryContent", () => {
  it("treats a NUL byte as binary, as git does", () => {
    expect(isBinaryContent(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x14]))).toBe(
      true
    );
  });

  it("treats content that is mostly control characters as binary", () => {
    const bytes = Buffer.alloc(200, 0x41);
    for (let index = 0; index < 40; index += 1) bytes[index * 5] = 0x10;
    expect(isBinaryContent(bytes)).toBe(true);
  });

  it("keeps ordinary text, tabs, CRLF, ANSI colour and Latin-1 as text", () => {
    expect(isBinaryContent(Buffer.from("a\tb\r\nc\u001b[31mred\u001b[0m\n"))).toBe(
      false
    );
    expect(isBinaryContent(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))).toBe(false);
    expect(isBinaryContent(Buffer.alloc(0))).toBe(false);
  });
});
