/**
 * The background reads of a remote wait for the workspace side to be asked for.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf8" });

test("the hidden branch read fetches only with the workspace side on", (t) => {
  const root = mkdtempSync(join(tmpdir(), "no-network-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
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
  const read = (extra: NodeJS.ProcessEnv) =>
    execFileSync(process.execPath, ["--import", "tsx", "src/cli.ts", "_trail-branches", mine], { env: { ...env, ...extra } as NodeJS.ProcessEnv, stdio: "pipe" });
  const seen = () => git(mine, "branch", "-r");
  read({});
  assert.doesNotMatch(seen(), /origin\/work/, "not asked for: no fetch");
  read({ TRAIL_CLOUD: "1" });
  assert.match(seen(), /origin\/work/, "asked for: it fetches");
});
