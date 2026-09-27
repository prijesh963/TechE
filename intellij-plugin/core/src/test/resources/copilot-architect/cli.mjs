// fake cli for extraction test
//
// Also stands in for the bundled CLI when RepoRegistrationServiceTest
// actually runs it (not just extracts it): appends every invocation's argv
// to argv.log in its own working directory (RepoRegistrationService runs it
// with cwd set to the extraction directory), and simulates a CLI-side
// validation failure for any repo name starting with "FAIL_", so both the
// success and failure paths through RepoRegistrationService are exercised
// against a real spawned process rather than a mock.
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync("argv.log", `${JSON.stringify(args)}\n`);

const repoName = args[2];
if (repoName && repoName.startsWith("FAIL_")) {
  process.stderr.write(`workspace add: repo "${repoName}" is invalid\n`);
  process.exit(1);
}
