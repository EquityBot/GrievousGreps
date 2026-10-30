/**
 * `npm test` must not be able to write to the home it was started with. Proved on a
 * copy of the runner, with one probe as its whole suite and a scratch folder standing
 * in for the home: this test never touches a real one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const probe = `import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
test("writes wherever a home is said to be", () => {
  const places = [homedir(), process.env.HOME, process.env.USERPROFILE, process.env.TRAIL_HOME, process.env.CLAUDE_CONFIG_DIR, process.env.CODEX_HOME, process.env.APPDATA, process.env.LOCALAPPDATA];
  for (const place of places) {
    mkdirSync(place!, { recursive: true });
    writeFileSync(join(place!, "written-by-the-probe"), "x");
  }
  writeFileSync(join(homedir(), "settings-probe.json"), "{}");
  writeFileSync(process.env.PROBE_SAYS!, homedir());
});
`;

function snapshot(dir: string, into = new Map<string, string>()): Map<string, string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) snapshot(path, into);
    else into.set(path, readFileSync(path, "utf8"));
  }
  return into;
}

test("the runner gives the suite a temporary home and leaves the one it started with unchanged", (t) => {
  const root = mkdtempSync(join(tmpdir(), "test-home-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sentinel = join(root, "sentinel");
  for (const dir of [".claude", ".trail", ".codex"]) mkdirSync(join(sentinel, dir), { recursive: true });
  writeFileSync(join(sentinel, ".claude", "settings.json"), `{"hooks":"the person's own"}`);
  writeFileSync(join(sentinel, ".trail", "state.json"), "{}");
  writeFileSync(join(sentinel, ".gitconfig"), "[user]\n\tname = Someone\n");
  const before = snapshot(sentinel);

  const copy = join(root, "copy");
  mkdirSync(join(copy, "scripts"), { recursive: true });
  mkdirSync(join(copy, "test"));
  copyFileSync(join(repo, "scripts", "run-tests.mjs"), join(copy, "scripts", "run-tests.mjs"));
  writeFileSync(join(copy, "test", "probe.test.ts"), probe);
  symlinkSync(join(repo, "node_modules"), join(copy, "node_modules"), "junction");

  const says = join(root, "probe-says");
  const run = spawnSync(process.execPath, [join(copy, "scripts", "run-tests.mjs")], {
    cwd: copy,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: undefined, // set by this test's own runner, it would stop the inner one running anything
      PROBE_SAYS: says,
      HOME: sentinel,
      USERPROFILE: sentinel,
      APPDATA: join(sentinel, "AppData", "Roaming"),
      LOCALAPPDATA: join(sentinel, "AppData", "Local"),
      TRAIL_HOME: join(sentinel, ".trail"),
      CLAUDE_CONFIG_DIR: join(sentinel, ".claude"),
      CODEX_HOME: join(sentinel, ".codex"),
    },
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual([...snapshot(sentinel)], [...before], "the home it started with is unchanged");
  const used = readFileSync(says, "utf8");
  assert.ok(!resolve(used).startsWith(resolve(sentinel)), "the suite saw another home");
  assert.equal(existsSync(used), false, "and that home is gone afterwards");
});
