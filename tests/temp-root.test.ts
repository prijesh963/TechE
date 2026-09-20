import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

describe("the run's temp root", () => {
  it("redirects fixtures into a directory the run owns", async () => {
    // Without this the suite leaks a directory per fixture: 234 a run, and
    // 45,000 on a machine that had been running it for a while. The net is
    // worth a test because it is invisible when it works — a broken setup
    // file would put fixtures back in the system temp directory and nothing
    // else would notice.
    const root = process.env.COPILOT_TEST_TMP_ROOT;
    expect(root, "global setup did not publish a temp root").toBeTruthy();

    // The redirect is what makes it forget-proof: every `mkdtemp` in the
    // suite goes through `os.tmpdir()`, so none of them has to know.
    expect(tmpdir()).toBe(root);

    const fixture = await mkdtemp(path.join(tmpdir(), "temp-root-check-"));
    expect(fixture.startsWith(String(root))).toBe(true);

    const entries = await readdir(String(root));
    expect(entries).toContain(path.basename(fixture));
  });

  it("points the variables a spawned process would read", async () => {
    // Tests shell out to the CLI, and a subprocess makes its own temp files.
    // They land in the run root too, or the leak survives in the one place
    // this suite cannot see.
    const root = process.env.COPILOT_TEST_TMP_ROOT;

    expect(process.env.TMPDIR).toBe(root);
    expect(process.env.TMP).toBe(root);
    expect(process.env.TEMP).toBe(root);
  });
});
