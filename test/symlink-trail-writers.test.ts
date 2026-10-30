/**
 * Writers under `.trail/` and the wiring `init` lays down: a repository can commit any
 * of those paths as a link, and none of them may write, rename or delete through it.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mapDirFor } from "../src/context/map-dir.js";
import { ensureRepoTrail, ignoreInTrailDir } from "../src/notes/repo-trail.js";
import { writeNote } from "../src/notes/notes.js";
import { writeTeamFile } from "../src/cloud/team-file.js";
import { cacheDir, emptyStats, writeStats } from "../src/util/state.js";
import { runRetract } from "../src/hosts/retract.js";
import { linkLeavingRoot } from "../src/util/safe-fs.js";

function sandbox(t: TestContext): { repo: string; outside: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "trail-writers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const outside = join(root, "outside");
  mkdirSync(repo);
  mkdirSync(outside);
  spawnSync("git", ["init", "-q", repo]);
  return { repo, outside, root };
}

const linkDir = (target: string, path: string): void => symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");

function linkFile(t: TestContext, target: string, path: string): boolean {
  try {
    symlinkSync(target, path, "file");
    return true;
  } catch {
    t.skip("file links need a privilege here");
    return false;
  }
}

test("ignoreInTrailDir writes nothing through a linked .trail or .trail/.gitignore", (t) => {
  const { repo, outside } = sandbox(t);
  linkDir(outside, join(repo, ".trail"));
  ignoreInTrailDir(repo, "cache/");
  assert.deepEqual(readdirSync(outside), []);

  const other = sandbox(t);
  mkdirSync(join(other.repo, ".trail"));
  const victim = join(other.outside, "victim");
  writeFileSync(victim, "ORIGINAL\n");
  if (!linkFile(t, victim, join(other.repo, ".trail", ".gitignore"))) return;
  ignoreInTrailDir(other.repo, "cache/");
  assert.equal(readFileSync(victim, "utf8"), "ORIGINAL\n");
});

test("moveOldMap does not move a map through a linked .trail, or move a linked graft", (t) => {
  const { repo, outside } = sandbox(t);
  mkdirSync(join(outside, "learnings"));
  mkdirSync(join(repo, "graft"));
  writeFileSync(join(repo, "graft", "INDEX.md"), "map\n");
  linkDir(outside, join(repo, ".trail"));
  mapDirFor(repo);
  assert.ok(existsSync(join(repo, "graft", "INDEX.md")), "the map stays in the repo");
  assert.deepEqual(readdirSync(outside), ["learnings"]);

  const other = sandbox(t);
  mkdirSync(join(other.repo, ".trail", "learnings"), { recursive: true });
  writeFileSync(join(other.outside, "INDEX.md"), "map\n");
  linkDir(other.outside, join(other.repo, "graft"));
  mapDirFor(other.repo);
  assert.ok(lstatSync(join(other.repo, "graft")).isSymbolicLink(), "the link is not renamed into .trail/cache");
  assert.equal(existsSync(join(other.repo, ".trail", "cache")), false);
});

test("ensureRepoTrail refuses a linked .trail and replaces a linked README", (t) => {
  const { repo, outside } = sandbox(t);
  linkDir(outside, join(repo, ".trail"));
  assert.throws(() => ensureRepoTrail(repo), /symlink/);
  assert.deepEqual(readdirSync(outside), []);

  const other = sandbox(t);
  mkdirSync(join(other.repo, ".trail"));
  const victim = join(other.outside, "victim");
  writeFileSync(victim, "ORIGINAL\n");
  if (!linkFile(t, victim, join(other.repo, ".trail", "README.md"))) return;
  ensureRepoTrail(other.repo);
  assert.equal(readFileSync(victim, "utf8"), "ORIGINAL\n");
  assert.equal(lstatSync(join(other.repo, ".trail", "README.md")).isSymbolicLink(), false);
});

test("writeNote does not write through a dangling link at the learning's name", (t) => {
  const { repo, outside, root } = sandbox(t);
  const home = process.env.TRAIL_HOME;
  process.env.TRAIL_HOME = join(root, "home");
  t.after(() => {
    if (home === undefined) delete process.env.TRAIL_HOME;
    else process.env.TRAIL_HOME = home;
  });
  const input = { title: "About a thing", author: "A", date: "2026-10-30", branch: "main", body: "x" };
  const first = writeNote(repo, input as never);
  rmSync(first.path);
  const target = join(outside, "not-yet");
  if (!linkFile(t, target, first.path)) return;
  writeNote(repo, input as never);
  assert.equal(existsSync(target), false);
});

test("writeTeamFile writes nothing through a linked .trail", (t) => {
  const { repo, outside } = sandbox(t);
  linkDir(outside, join(repo, ".trail"));
  const cloud = { url: "https://example.invalid", workspace: { slug: "team", name: "Team" } };
  assert.equal(writeTeamFile(repo, cloud as never), false);
  assert.deepEqual(readdirSync(outside), []);
});

test("cacheDir refuses a linked map or .cache, so stats never land outside", (t) => {
  const { repo, outside } = sandbox(t);
  linkDir(outside, join(repo, "graft"));
  assert.throws(() => cacheDir(repo), /symlink/);
  assert.throws(() => writeStats(repo, emptyStats()), /symlink/);
  assert.deepEqual(readdirSync(outside), []);

  const other = sandbox(t);
  mkdirSync(join(other.repo, "graft"));
  linkDir(other.outside, join(other.repo, "graft", ".cache"));
  assert.throws(() => cacheDir(other.repo), /symlink/);
});

test("retract neither deletes nor edits through a committed link", (t) => {
  const { repo, outside } = sandbox(t);
  mkdirSync(join(outside, "cache"));
  writeFileSync(join(outside, "cache", "keep"), "x");
  writeFileSync(join(outside, "AGENTS.md"), "<!-- graft:start -->\nblock\n<!-- graft:end -->\n");
  linkDir(outside, join(repo, ".trail"));
  runRetract(repo, { home: join(outside, "no-home"), apply: true, global: false });
  assert.ok(existsSync(join(outside, "cache", "keep")), ".trail/cache was outside the repo");

  const other = sandbox(t);
  const victim = join(other.outside, "AGENTS.md");
  const text = "mine\n<!-- graft:start -->\nblock\n<!-- graft:end -->\n<!-- trail:start -->\nblock\n<!-- trail:end -->\n";
  writeFileSync(victim, text);
  if (!linkFile(t, victim, join(other.repo, "AGENTS.md"))) return;
  runRetract(other.repo, { home: join(other.outside, "no-home"), apply: true, global: false });
  assert.equal(readFileSync(victim, "utf8"), text);
});

test("linkLeavingRoot allows a link that stays in the repo", (t) => {
  const { repo, outside } = sandbox(t);
  writeFileSync(join(repo, "CLAUDE.md"), "x");
  if (!linkFile(t, join(repo, "CLAUDE.md"), join(repo, "AGENTS.md"))) return;
  assert.equal(linkLeavingRoot(repo, join(repo, "AGENTS.md")), null);
  linkDir(outside, join(repo, ".claude"));
  assert.equal(linkLeavingRoot(repo, join(repo, ".claude", "settings.json")), join(repo, ".claude"));
  assert.equal(linkLeavingRoot(repo, join(repo, "absent", "file")), null);
});

test("init refuses a repo with a committed link on a path it would write, and writes nothing there", (t) => {
  const { repo, outside, root } = sandbox(t);
  linkDir(outside, join(repo, ".claude"));
  const home = join(root, "home");
  mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home, TRAIL_HOME: join(home, ".trail"), DO_NOT_TRACK: "1" };
  const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "init", repo, "--agents", "claude", "--no-build"], { env, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /refusing to set up/);
  assert.deepEqual(readdirSync(outside), []);
});

test("retract calls a target behind a link a link, and an unreadable file unreadable", (t) => {
  const { repo, outside } = sandbox(t);
  writeFileSync(join(outside, "mcp.json"), "{}\n");
  symlinkSync(join(outside, "mcp.json"), join(repo, ".mcp.json"), "file");
  const opts = { home: join(outside, "no-home"), apply: true, global: false };
  const action = (dir: string) => runRetract(dir, opts).find((r) => r.path.endsWith(".mcp.json"))?.action;
  assert.equal(action(repo), "skipped-link");
  const other = sandbox(t);
  writeFileSync(join(other.repo, ".mcp.json"), "not json");
  assert.equal(action(other.repo), "skipped-unparseable");
});
