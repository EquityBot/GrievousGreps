/**
 * A --dir can reach the repository through another name for it: a different case on a
 * case-insensitive volume, a linked ancestor, a link to the root or a directory under
 * it, or a drive mapped onto one. Each is still inside, so the links the repository
 * commits below that name must be refused like any other.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { tmpRepo } from "./helpers.js";
import { buildGraph } from "../src/graph/build.js";
import { contextDirFor } from "../src/context/node-file.js";

/** A sandbox holding `repo/` (one small source file) and `outside/`, removed after the test. */
function sandbox(t: TestContext): { repo: string; outside: string } {
  const root = tmpRepo("symlink-alias");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const outside = join(root, "outside");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(repo, "src", "a.ts"), "export function zeta(): number {\n  return 1;\n}\n");
  return { repo, outside };
}

/** Directory link; a junction on Windows, which needs no privilege. */
function linkDir(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

test("a --dir spelled through another name for the repo root is still checked from it", async (t) => {
  const { repo, outside } = sandbox(t);
  linkDir(outside, join(repo, "tools"));
  // Stands in for a case-insensitive alias or macOS /tmp -> /private/tmp: lexically
  // outside the repo, yet the same directory.
  const alias = join(dirname(repo), "alias");
  linkDir(repo, alias);
  const contextDir = join(alias, "tools", "ctx");
  assert.throws(() => contextDirFor(repo, contextDir), /symlink/);
  await assert.rejects(buildGraph(repo, { contextDir }), /symlink/);
  assert.deepEqual(readdirSync(outside), []);
  // A committed link back to the root, reached through the alias, is still a symlink
  // the repository controls.
  linkDir(repo, join(repo, "self"));
  const viaSelf = join(alias, "self", "ctx");
  assert.throws(() => contextDirFor(repo, viaSelf), /symlink/);
  await assert.rejects(buildGraph(repo, { contextDir: viaSelf }), /symlink/);
  assert.equal(existsSync(join(repo, "ctx")), false);
  // An alias of a directory under the root, with a committed link back up from it.
  mkdirSync(join(repo, "sub"));
  linkDir(repo, join(repo, "sub", "up"));
  const subAlias = join(dirname(repo), "sub-alias");
  linkDir(join(repo, "sub"), subAlias);
  const viaUp = join(subAlias, "up", "ctx");
  assert.throws(() => contextDirFor(repo, viaUp), /symlink/);
  await assert.rejects(buildGraph(repo, { contextDir: viaUp }), /symlink/);
  assert.equal(existsSync(join(repo, "ctx")), false);
});

test("a --dir on a drive aliasing a repo directory still checks the committed links below it", async (t) => {
  if (process.platform !== "win32") return t.skip("subst drives are Windows-only");
  const free = "ZYXWVUTSRQPONMLKJ".split("").find((l) => !existsSync(`${l}:\\`));
  if (!free) return t.skip("no free drive letter");
  const { repo, outside } = sandbox(t);
  mkdirSync(join(repo, "sub"));
  linkDir(repo, join(repo, "sub", "up"));
  execFileSync("subst", [`${free}:`, join(repo, "sub")]);
  t.after(() => execFileSync("subst", [`${free}:`, "/d"]));
  const contextDir = `${free}:\\up\\ctx`;
  assert.throws(() => contextDirFor(repo, contextDir), /symlink/);
  await assert.rejects(buildGraph(repo, { contextDir }), /symlink/);
  assert.equal(existsSync(join(repo, "ctx")), false);
  assert.deepEqual(readdirSync(outside), []);
});
