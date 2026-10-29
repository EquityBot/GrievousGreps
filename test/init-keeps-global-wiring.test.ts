/**
 * An init for one repo never removes machine-wide wiring.
 *
 * `init` converges the repo it runs in by retracting every host not named in
 * `--agents`. That sweep used to carry the machine-wide scope too, so
 * `graft init B --agents cursor` deleted the user-level Claude hooks, shim and MCP
 * entry and the Codex hooks that every other repo on the machine relies on. Only an
 * explicit `uninstall` may remove those. Scratch homes and repos only.
 *
 * Adapted from Nishad Herath's fix in nishadherath/fork_Graft (a241f6fb308d, MIT).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCli, tmpRepo } from "./helpers.js";

process.env.GRAFT_MCP_NPX = "1";

function repoWithSource(tag: string): string {
  const repo = tmpRepo(tag);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "export function a(): number {\n  return 1;\n}\n");
  return repo;
}

function hookEvents(file: string): string[] {
  const settings = JSON.parse(readFileSync(file, "utf8")) as { hooks?: Record<string, unknown> };
  return Object.keys(settings.hooks ?? {}).sort();
}

const INIT = ["--no-build", "--no-statusline"];

test("init for other hosts leaves the user-level Claude and Codex wiring in place", () => {
  const a = repoWithSource("keeps-global-a");
  const b = repoWithSource("keeps-global-b");
  const home = tmpRepo("keeps-global-home");
  mkdirSync(join(home, ".codex"));
  try {
    const first = runCli(["init", a, "--agents", "claude", "agents", ...INIT], { home });
    assert.equal(first.status, 0, first.describe());
    const settings = join(home, ".claude", "settings.json");
    const shim = join(home, ".claude", "helpers", "graft-hooks.cjs");
    const codexHooks = join(home, ".codex", "hooks.json");
    const events = hookEvents(settings);
    assert.ok(events.includes("SessionStart"), `claude init wires the user-level hooks\n${first.describe()}`);
    assert.ok(existsSync(shim), "user-level hooks shim");
    assert.ok(existsSync(codexHooks), "user-level Codex hooks");
    const codexBefore = readFileSync(codexHooks, "utf8");

    const second = runCli(["init", b, "--agents", "cursor", ...INIT], { home });
    assert.equal(second.status, 0, second.describe());
    assert.doesNotMatch(second.stderr, /removed .*(\.claude|\.codex)/, second.describe());
    assert.deepEqual(hookEvents(settings), events, "user-level Claude hook events are untouched");
    assert.ok(existsSync(shim), "user-level hooks shim survives");
    assert.equal(readFileSync(codexHooks, "utf8"), codexBefore, "user-level Codex hooks are untouched");
  } finally {
    for (const d of [a, b, home]) rmSync(d, { recursive: true, force: true });
  }
});
