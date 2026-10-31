/**
 * Runs the test suite without depending on shell glob expansion.
 *
 * `node --test test/*.test.ts` needs the *shell* to expand that glob, and on
 * Windows nothing does: npm runs scripts through `cmd.exe` regardless of the
 * shell that invoked npm, and Node's `--test` only accepts glob patterns itself
 * from Node 21 (this package supports >=20). The literal pattern reaches Node as
 * a filename and it exits with `Could not find '…\test\*.test.ts'` — so the
 * Windows CI leg reported failure while actually running zero tests.
 *
 * Enumerating the files here instead means `npm test` behaves identically in
 * cmd.exe, PowerShell, bash and CI, on any supported Node.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const testDir = join(repoRoot, "test");

// Sorted so a failure is reported in the same order on every platform and run.
const files = readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts"))
  .sort()
  .map((f) => join("test", f)); // relative: 480 absolute paths overflow Windows' 32,767-character command line

if (files.length === 0) {
  console.error(`✗ no test files found in ${testDir}`);
  process.exit(1);
}

// These hold real time limits against real processes: a clean-tree probe gives git 150 ms, as a
// hook must stay quick, and a wait for a workspace has its own limit. Each file passes on its own, but
// with the other files running beside it git took over 150 ms on every call, so they run after
// the rest, one at a time.
const ALONE = [
  "mcp-connector-review",
  "skills-probes",
  "skills-probes-init-paths-1b",
  "skills-probes-trail-files",
  "skills-prompt",
  "skills-prompt-attacks",
  "skills-session-start",
  "trail-connect-cli",
].map((name) => join("test", `${name}.test.ts`));

// Several tests `git init` a scratch repo and `git commit` into it to exercise the
// incremental/submodule/ingest git paths. Those commits inherit the developer's
// global git config — so a contributor who signs commits (gpg, or gitsign, whose
// x509 flow opens a browser for OIDC on EVERY commit) gets a signing storm from a
// run that has nothing to do with their identity. Inject config via GIT_CONFIG_*
// (git merges these over the user's config for this process tree only) so test
// commits never sign, without touching anyone's global settings.
const gitEnv = {
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "commit.gpgsign", GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "tag.gpgsign", GIT_CONFIG_VALUE_1: "false",
};

// Tests make thousands of scratch repos and homes under the temp folder and
// don't all remove them: a day of runs left over 50,000 folders (6 GB). Give the
// run its own temp folder and remove it at the end, whatever the outcome.
const runTmp = mkdtempSync(join(tmpdir(), "trail-test-run-"));
const tmpEnv = { TMPDIR: runTmp, TEMP: runTmp, TMP: runTmp };

// The suite runs `init`, hook and skill code that writes to the person's home, so
// no test may see the real one: a run once rewrote ~/.claude/settings.json. Every
// way the code finds a home points inside the run's temp folder, set here before
// any test loads, so it goes with that folder at the end.
const home = join(runTmp, "home");
mkdirSync(home);
// With no global git config of their own, the tests' commits still need a name.
writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Trail Tests\n\temail = tests@example.invalid\n[init]\n\tdefaultBranch = main\n");
const homeEnv = {
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "AppData", "Roaming"),
  LOCALAPPDATA: join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_CACHE_HOME: join(home, ".cache"),
  TRAIL_HOME: join(home, ".trail"),
  CLAUDE_CONFIG_DIR: join(home, ".claude"),
  CODEX_HOME: join(home, ".codex"),
};

// A graft repo moves to trail when a session opens on a machine with the trail
// command, so a contributor who has trail installed would see test repos move.
// Off for the run; the tests of the move turn it back on.
const runFiles = (list, ...flags) =>
  spawnSync(process.execPath, ["--import", "tsx", "--test", ...flags, ...list], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...gitEnv, ...tmpEnv, ...homeEnv, GRAFT_NO_TRAIL_SWITCH: "1" },
  });
// `npm test -- --coverage` also writes each run's coverage to coverage-<run>.lcov
// for the Codecov upload, keeping the spec report on stdout.
const coverage = process.argv.slice(2).includes("--coverage");
const coverageFlags = (run) =>
  coverage
    ? [
        "--experimental-test-coverage",
        "--test-reporter=spec",
        "--test-reporter-destination=stdout",
        "--test-reporter=lcov",
        `--test-reporter-destination=coverage-${run}.lcov`,
      ]
    : [];
const results = [runFiles(files.filter((f) => !ALONE.includes(f)), ...coverageFlags("main"))];
const alone = files.filter((f) => ALONE.includes(f));
if (alone.length > 0) results.push(runFiles(alone, "--test-concurrency=1", ...coverageFlags("alone")));
try {
  rmSync(runTmp, { recursive: true, force: true });
} catch {
  /* best effort: a locked file on Windows must not fail the run */
}

for (const result of results) {
  if (result.error) {
    console.error(`✗ could not start the test runner: ${result.error.message}`);
    process.exit(1);
  }
  // A signal-killed run reports null status; treat anything non-zero as failure.
  if (result.status !== 0) process.exit(result.status ?? 1);
}
