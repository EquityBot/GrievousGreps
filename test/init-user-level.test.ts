/**
 * A plain `trail init` writes inside the repository and Trail's own ~/.trail, and nothing an agent
 * reads as user-level settings: that takes `--global`. Run with a scratch home only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WIRING_OPTS } from "../src/upkeep.js";

const USER_LEVEL = [".claude", ".codex", ".gemini", ".cursor"];

function init(t: { after: (f: () => void) => void }, ...flags: string[]) {
  const root = mkdtempSync(join(tmpdir(), "init-user-level-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const repo = join(root, "repo");
  for (const dir of USER_LEVEL) mkdirSync(join(home, dir), { recursive: true });
  mkdirSync(repo);
  writeFileSync(join(repo, "a.ts"), "export function f() {}\n");
  spawnSync("git", ["init", "-q"], { cwd: repo });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_TEST_CONTEXT: undefined,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    TRAIL_HOME: join(home, ".trail"),
    CLAUDE_CONFIG_DIR: undefined,
    CODEX_HOME: undefined,
  };
  const run = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src", "bin", "trail.ts"), "init", repo, "--agents", "claude", "agents", "gemini", "antigravity", "cursor", ...flags], { encoding: "utf8", env });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  return { home, repo, said: run.stdout + run.stderr };
}

for (const flags of [[], ["--no-global"]]) {
  test(`init ${flags.join(" ") || "with no flag"} leaves user-level config alone, and says so`, (t) => {
    const { home, repo, said } = init(t, ...flags);
    for (const dir of USER_LEVEL) assert.deepEqual(readdirSync(join(home, dir)), [], dir);
    assert.equal(existsSync(join(home, ".claude.json")), false);
    assert.ok(existsSync(join(repo, ".claude", "settings.json")), "the repo's own wiring stays");
    assert.match(said, /left out user-level config.*--global/);
  });
}

test("init --global writes user-level config when asked", (t) => {
  const { home, said } = init(t, "--global");
  assert.ok(existsSync(join(home, ".claude", "settings.json")));
  assert.ok(readdirSync(join(home, ".codex")).length > 0);
  assert.doesNotMatch(said, /left out user-level config/);
});

test("a wired repo with no recorded choice replays nothing outside itself", () => {
  assert.equal(DEFAULT_WIRING_OPTS.global, false);
});
