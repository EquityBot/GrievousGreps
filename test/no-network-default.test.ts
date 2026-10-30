/**
 * The background reads of a remote wait for the workspace side to be asked for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" });

function scene(t: { after: (f: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "no-network-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 })); // the detached read may still hold it on Windows
  const bare = join(root, "r.git");
  git(root, "init", "-q", "--bare", "-b", "main", bare);
  const mine = join(root, "mine");
  const theirs = join(root, "theirs");
  git(root, "init", "-q", "-b", "main", mine);
  writeFileSync(join(mine, "a.txt"), "a\n");
  git(mine, "add", ".");
  git(mine, "commit", "-q", "-m", "first");
  git(mine, "remote", "add", "origin", bare);
  git(mine, "push", "-q", "origin", "main");
  git(root, "clone", "-q", bare, theirs);
  git(theirs, "checkout", "-q", "-b", "work");
  writeFileSync(join(theirs, "b.txt"), "b\n");
  git(theirs, "add", ".");
  git(theirs, "commit", "-q", "-m", "second");
  git(theirs, "push", "-q", "origin", "work");
  const home = join(root, "home");
  const env = { ...process.env, HOME: home, USERPROFILE: home, TRAIL_CLOUD: undefined, TRAIL_NO_FETCH: undefined, DO_NOT_TRACK: "1" };
  const run = (extra: NodeJS.ProcessEnv, ...args: string[]) =>
    execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { env: { ...env, ...extra } as NodeJS.ProcessEnv, stdio: "pipe" });
  return { mine, home, env, run, seen: () => git(mine, "branch", "-r") };
}

test("the hidden branch read fetches only with the workspace side on, or when a person asked", (t) => {
  const { mine, run, seen } = scene(t);
  run({}, "_trail-branches", mine);
  assert.doesNotMatch(seen(), /origin\/work/, "not asked for: no fetch");
  run({}, "_trail-branches", mine, "--asked");
  assert.match(seen(), /origin\/work/, "asked: it fetches");
});

test("the workspace side on fetches too", (t) => {
  const { mine, run, seen } = scene(t);
  run({ TRAIL_CLOUD: "1" }, "_trail-branches", mine);
  assert.match(seen(), /origin\/work/);
});

test("a person running `team` asked, so its background read fetches", async (t) => {
  const { mine, home, env, seen } = scene(t);
  // Through the build: the detached read starts dist/cli.js, which a run from src/ has no way to.
  execFileSync(process.execPath, ["dist/bin/trail.js", "team", mine], { env: env as NodeJS.ProcessEnv, stdio: "pipe" });
  for (let i = 0; i < 80 && !/origin\/work/.test(seen()); i++) await new Promise((r) => setTimeout(r, 250));
  assert.match(seen(), /origin\/work/);
  // The read goes on past the fetch: its cache marks it running until it ends, and on Windows
  // the folder cannot go whilst it holds files there.
  const running = () => readdirSync(home, { recursive: true, encoding: "utf8" }).some((f) => {
    try {
      return f.endsWith(".json") && readFileSync(join(home, f), "utf8").includes('"runningSince"');
    } catch {
      return false;
    }
  });
  for (let i = 0; i < 160 && running(); i++) await new Promise((r) => setTimeout(r, 250));
});
