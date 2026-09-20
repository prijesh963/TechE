/**
 * Gives the whole run one temp directory, so nothing has to remember to clean
 * up after itself.
 *
 * The suite calls `mkdtemp(path.join(tmpdir(), …))` in 110 places across 33
 * files, and two of them removed what they made. Everything else was left on
 * disk: 234 directories per run, and a machine that had run the suite for a
 * while carried 45,000 of them. The cost is disk — gigabytes, silently, with
 * nothing pointing at the cause — and a slower suite as the temp directory
 * fills.
 *
 * Fixed here rather than in each test on purpose. Adding an `afterEach` to 33
 * files would clean up today's tests and do nothing about tomorrow's: the next
 * `mkdtemp` written without one would leak again, and nothing would catch it.
 * `os.tmpdir()` reads `TMPDIR` on every call, so pointing it at a per-run root
 * means every fixture lands inside that root — including ones made by
 * subprocesses the tests spawn — and the root is removed wholesale when the
 * run ends.
 *
 * Tests can still make and delete their own directories; this is a net, not a
 * replacement.
 */
const root = process.env.COPILOT_TEST_TMP_ROOT;

if (root) {
  // All three, because `os.tmpdir()` reads TMPDIR on POSIX and TEMP/TMP on
  // Windows, and a subprocess may consult either.
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
}
