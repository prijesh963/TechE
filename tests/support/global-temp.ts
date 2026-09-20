import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Creates the run's temp root and removes it when the run ends.
 *
 * Runs in the main process before any worker is forked, so the path reaches
 * the workers through the environment they inherit. `temp-root.ts` is what
 * reads it there.
 *
 * The teardown is the whole point: one `rm` reclaims every fixture the run
 * made, whether or not the test that made it thought about cleaning up.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const root = await mkdtemp(path.join(tmpdir(), "copilot-architect-run-"));
  process.env.COPILOT_TEST_TMP_ROOT = root;

  return async () => {
    // `force` so a run that failed early, before the root was populated, does
    // not fail again in teardown and mask the real failure.
    await rm(root, { recursive: true, force: true });
  };
}
