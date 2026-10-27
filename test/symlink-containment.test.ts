/**
 * A repository — or a pull request the GitHub App checks out — can commit any path
 * graft writes, reads or deletes as a symlink: `graft/` itself, a directory under
 * it, a card or sidecar leaf, `.gitignore`/`.ignore`, an instruction file. None of
 * these may ever be followed outside the repository. Each test plants the link,
 * runs the real entry point, and checks the outside target is exactly as it was.
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative } from "node:path";
import { BracketSynthesizer, PassthroughSummarizer, tmpRepo } from "./helpers.js";
import { resolveInside } from "../src/util/safe-fs.js";
import { buildGraph } from "../src/graph/build.js";
import { buildContext } from "../src/context/build.js";
import { ask, formatAsk } from "../src/ask/ask.js";
import { loadNameCache, saveNameCache } from "../src/blast/name.js";
import { loadGraphCached } from "../src/graph/load.js";
import { readGraph } from "../src/graph/write.js";
import { readAskIndex } from "../src/ask/index-file.js";
import { contextDirFor, readManifest } from "../src/context/node-file.js";
import { fingerprintPath, readFingerprint } from "../src/graph/fingerprint.js";
import { extractCachePath, readExtractCache } from "../src/graph/extract-cache.js";
import { seedGraph } from "../src/graph/seed.js";
import { acquireLockIn, patchBuildConfig, readBuildConfig, releaseLockIn, resolveContextDir } from "../src/util/state.js";
import { readWorkspace } from "../src/graph/workspace.js";
import { runRetract } from "../src/hosts/retract.js";
import { assembleContextGraph } from "../src/viz/assemble.js";

/** A sandbox holding `repo/` (one small source file) and `outside/`, removed after the test. */
function sandbox(t: TestContext): { repo: string; outside: string } {
  const root = tmpRepo("symlink");
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

/** File link, or skip the test where the platform will not create one. */
function linkFile(t: TestContext, target: string, path: string): boolean {
  try {
    symlinkSync(target, path, "file");
    return true;
  } catch (err) {
    t.skip(`file symlinks unavailable here: ${(err as NodeJS.ErrnoException).code}`);
    return false;
  }
}

const isLink = (p: string): boolean => lstatSync(p).isSymbolicLink();

/** Snapshot of a directory's files and contents, to prove nothing changed. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) out[name] = readFileSync(join(dir, name), "utf8");
  return out;
}

/** Run the test body with graft's ignore-file opt-outs cleared, then restore them. */
async function withIgnoreFilesOn(body: () => Promise<void>): Promise<void> {
  const saved = { gi: process.env.GRAFT_NO_GITIGNORE, ig: process.env.GRAFT_NO_IGNORE };
  delete process.env.GRAFT_NO_GITIGNORE;
  delete process.env.GRAFT_NO_IGNORE;
  try {
    await body();
  } finally {
    if (saved.gi !== undefined) process.env.GRAFT_NO_GITIGNORE = saved.gi;
    if (saved.ig !== undefined) process.env.GRAFT_NO_IGNORE = saved.ig;
  }
}

test("resolveInside refuses escapes and symlinked components, and allows missing ones", (t) => {
  const { repo, outside } = sandbox(t);
  assert.equal(resolveInside(repo, "graft/.cache/x.json"), join(repo, "graft", ".cache", "x.json"));
  assert.throws(() => resolveInside(repo, "../outside/x"), /outside/);
  assert.throws(() => resolveInside(repo, join(outside, "x")), /outside/);
  assert.throws(() => resolveInside(repo, "src/a.ts/x"), /non-directory/);
  linkDir(outside, join(repo, "graft"));
  assert.throws(() => resolveInside(repo, "graft"), /symlink/);
  assert.throws(() => resolveInside(repo, "graft/.cache/x.json"), /symlink/);
});

test("graft build refuses a symlinked graft/ and deletes nothing it points at", async (t) => {
  const { repo, outside } = sandbox(t);
  const dir = join(outside, "dir");
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "sub", "keep.md"), "KEEP");
  linkDir(dir, join(repo, "graft"));

  await assert.rejects(buildGraph(repo), /symlink/);
  assert.equal(readFileSync(join(dir, "sub", "keep.md"), "utf8"), "KEEP");
  assert.deepEqual(readdirSync(dir), ["sub"], "no wiring, cards or cache written through the link");
});

test("graft build replaces a symlinked card instead of overwriting its target", async (t) => {
  const { repo, outside } = sandbox(t);
  const victim = join(outside, "victim.txt");
  writeFileSync(victim, "ORIGINAL");
  mkdirSync(join(repo, "graft", "src"), { recursive: true });
  const card = join(repo, "graft", "src", "a.md");
  if (!linkFile(t, victim, card)) return;

  await buildGraph(repo);
  assert.equal(readFileSync(victim, "utf8"), "ORIGINAL");
  assert.ok(!isLink(card), "the planted link is replaced by a real card");
  assert.match(readFileSync(card, "utf8"), /^# src\/a\.ts/);
});

test("graft build never appends to a symlinked .gitignore or .ignore", async (t) => {
  const { repo, outside } = sandbox(t);
  writeFileSync(join(outside, "gi.txt"), "ORIG-GI\n");
  writeFileSync(join(outside, "ig.txt"), "ORIG-IG\n");
  if (!linkFile(t, join(outside, "gi.txt"), join(repo, ".gitignore"))) return;
  if (!linkFile(t, join(outside, "ig.txt"), join(repo, ".ignore"))) return;

  await withIgnoreFilesOn(async () => {
    await buildGraph(repo);
  });
  assert.equal(readFileSync(join(outside, "gi.txt"), "utf8"), "ORIG-GI\n");
  assert.equal(readFileSync(join(outside, "ig.txt"), "utf8"), "ORIG-IG\n");
  assert.ok(isLink(join(repo, ".gitignore")) && isLink(join(repo, ".ignore")), "left for the repo to manage");
});

test("graft retract never rewrites a symlinked .gitignore or .ignore", (t) => {
  const { repo, outside } = sandbox(t);
  const gi = "keep-me\n# graft's local graph cache\n/graft/\n";
  const ig = "!graft/\ngraft/.cache/\nkeep-me\n";
  writeFileSync(join(outside, "gi.txt"), gi);
  writeFileSync(join(outside, "ig.txt"), ig);
  if (!linkFile(t, join(outside, "gi.txt"), join(repo, ".gitignore"))) return;
  if (!linkFile(t, join(outside, "ig.txt"), join(repo, ".ignore"))) return;

  runRetract(repo, { apply: true, global: false });
  assert.equal(readFileSync(join(outside, "gi.txt"), "utf8"), gi);
  assert.equal(readFileSync(join(outside, "ig.txt"), "utf8"), ig);
  assert.ok(isLink(join(repo, ".gitignore")) && isLink(join(repo, ".ignore")), "left for the repo to manage");
});

test("a sanity check: graft retract still strips real ignore files", (t) => {
  const { repo } = sandbox(t);
  writeFileSync(join(repo, ".gitignore"), "keep-me\n# graft's local graph cache\n/graft/\n");
  writeFileSync(join(repo, ".ignore"), "!graft/\nkeep-me\n");
  runRetract(repo, { apply: true, global: false });
  assert.equal(readFileSync(join(repo, ".gitignore"), "utf8"), "keep-me\n");
  assert.equal(readFileSync(join(repo, ".ignore"), "utf8"), "keep-me\n");
});

test("a sanity check: a plain build still writes both ignore files", async (t) => {
  const { repo } = sandbox(t);
  await withIgnoreFilesOn(async () => {
    await buildGraph(repo);
  });
  assert.match(readFileSync(join(repo, ".gitignore"), "utf8"), /^\/graft\/$/m);
  assert.match(readFileSync(join(repo, ".ignore"), "utf8"), /^!graft\/$/m);
});

test("graft build never writes or prunes sidecars through a symlinked graft/.cache", async (t) => {
  const { repo, outside } = sandbox(t);
  const cache = join(outside, "cache");
  mkdirSync(cache);
  for (const [i, name] of ["fingerprint.a.json", "fingerprint.b.json", "fingerprint.c.json", "extract.a.json", "extract.b.json", "extract.c.json", "unrelated.json"].entries()) {
    writeFileSync(join(cache, name), `{"n":${i}}`);
    utimesSync(join(cache, name), new Date(2020, 0, 1 + i), new Date(2020, 0, 1 + i));
  }
  const before = snapshot(cache);
  mkdirSync(join(repo, "graft"));
  linkDir(cache, join(repo, "graft", ".cache"));

  await buildGraph(repo);
  assert.deepEqual(snapshot(cache), before, "nothing created, rewritten or deleted outside");
  assert.ok(existsSync(join(repo, "graft", ".graph", "wiring.json")), "the graph itself still builds");
});

test("graft build replaces symlinked sidecar leaves, including the pid-named temp file", async (t) => {
  const { repo, outside } = sandbox(t);
  mkdirSync(join(repo, "graft", ".graph"), { recursive: true });
  mkdirSync(join(repo, "graft", ".cache"), { recursive: true });
  const targets = {
    [join(repo, "graft", ".graph", `wiring.json.${process.pid}.tmp`)]: join(outside, "tmp.txt"),
    [join(repo, "graft", ".graph", "wiring.json")]: join(outside, "wiring.txt"),
    [join(repo, "graft", ".cache", "ask-index.json")]: join(outside, "ask.txt"),
  };
  for (const [leaf, target] of Object.entries(targets)) {
    writeFileSync(target, "ORIGINAL");
    if (!linkFile(t, target, leaf)) return;
  }

  await buildGraph(repo);
  for (const target of Object.values(targets)) assert.equal(readFileSync(target, "utf8"), "ORIGINAL", target);
  const wiring = join(repo, "graft", ".graph", "wiring.json");
  assert.ok(!isLink(wiring));
  assert.ok(Array.isArray(JSON.parse(readFileSync(wiring, "utf8")).nodes));
});

test("the App's area-name cache neither follows nor reads a committed areas.json symlink", (t) => {
  const { repo, outside } = sandbox(t);
  const contextDir = join(repo, "graft");
  mkdirSync(join(contextDir, ".cache"), { recursive: true });
  const leaf = join(contextDir, ".cache", "areas.json");
  const secret = join(outside, "page.json");
  writeFileSync(secret, '{"secret":"x"}');
  if (!linkFile(t, secret, leaf)) return;
  assert.deepEqual(loadNameCache(contextDir), {}, "a link is a cache miss, never read through");

  rmSync(leaf);
  const gitconfig = join(outside, ".gitconfig");
  if (!linkFile(t, gitconfig, leaf)) return; // dangling, as in the report
  saveNameCache(contextDir, { "012fc729e56d6e92": "Auth" });
  assert.ok(!existsSync(gitconfig), "the dangling target is never created");
  assert.ok(!isLink(leaf));
  assert.deepEqual(JSON.parse(readFileSync(leaf, "utf8")), { "012fc729e56d6e92": "Auth" });
  assert.equal(readFileSync(secret, "utf8"), '{"secret":"x"}');
});

test("the area-name cache writes nothing through a symlinked graft/.cache", (t) => {
  const { repo, outside } = sandbox(t);
  mkdirSync(join(repo, "graft"));
  linkDir(outside, join(repo, "graft", ".cache"));
  saveNameCache(join(repo, "graft"), { k: "v" });
  assert.deepEqual(readdirSync(outside), []);
});

test("graft build --deep never writes manifest.json or the summary cache through a symlink", async (t) => {
  const { repo, outside } = sandbox(t);
  mkdirSync(join(repo, "graft", ".cache"), { recursive: true });
  const manifestTarget = join(outside, "manifest.txt");
  writeFileSync(manifestTarget, "ORIGINAL");
  if (!linkFile(t, manifestTarget, join(repo, "graft", "manifest.json"))) return;
  const tmpTarget = join(outside, "summaries.txt");
  if (!linkFile(t, tmpTarget, join(repo, "graft", ".cache", "summaries.json.tmp"))) return;

  await buildContext(repo, { model: "fake", summarizer: new PassthroughSummarizer(), synthesizer: new BracketSynthesizer() });
  assert.equal(readFileSync(manifestTarget, "utf8"), "ORIGINAL");
  assert.ok(!existsSync(tmpTarget), "the dangling temp-file target is never created");
  assert.ok(!isLink(join(repo, "graft", "manifest.json")));
  assert.ok(existsSync(join(repo, "graft", ".cache", "summaries.json")));
});

test("graft build --deep refuses a symlinked graft/", async (t) => {
  const { repo, outside } = sandbox(t);
  linkDir(outside, join(repo, "graft"));
  await assert.rejects(
    buildContext(repo, { model: "fake", summarizer: new PassthroughSummarizer(), synthesizer: new BracketSynthesizer() }),
    /symlink/,
  );
  assert.deepEqual(readdirSync(outside), []);
});

const QUERY = "authentication login token";

test("ask --source never inlines a file outside the repo named by a concept's sources", async (t) => {
  const { repo, outside } = sandbox(t);
  writeFileSync(join(outside, "secret.txt"), "DUMMY-SECRET-123\n");
  await buildGraph(repo);
  writeFileSync(
    join(repo, "graft", "leak.md"),
    [
      "---",
      "slug: leak",
      "name: authentication login token handler",
      "sources:",
      '  - path: "../outside/secret.txt:L1-L5"',
      "    hash: x",
      "---",
      "authentication login token handler",
      "",
    ].join("\n"),
  );

  const r = ask(repo, QUERY, { source: true });
  assert.ok(r.hits.some((h) => h.pointer.includes("../outside/secret.txt")), "the concept is still a hit");
  assert.doesNotMatch(JSON.stringify(r), /DUMMY-SECRET-123/);
  assert.doesNotMatch(formatAsk(r), /DUMMY-SECRET-123/);
});

test("ask never loads a symlinked concept node from outside the repo", async (t) => {
  const { repo, outside } = sandbox(t);
  writeFileSync(
    join(outside, "notes.md"),
    ["---", "slug: notes", "name: authentication login token", "---", "SECRET-NOTES-456 authentication login token", ""].join("\n"),
  );
  await buildGraph(repo);
  if (!linkFile(t, join(outside, "notes.md"), join(repo, "graft", "notes.md"))) return;

  const r = ask(repo, QUERY, { source: true });
  assert.doesNotMatch(JSON.stringify(r), /SECRET-NOTES-456/);
});

test("ask refuses a symlinked graft/ instead of listing what it points at", async (t) => {
  const { repo, outside } = sandbox(t);
  writeFileSync(join(outside, "notes.md"), "---\nslug: notes\nname: authentication login token\n---\nSECRET-NOTES-456\n");
  linkDir(outside, join(repo, "graft"));
  assert.throws(() => ask(repo, QUERY, { source: true }), /symlink/);
});

test("the viz context graph never reads a symlinked node or context dir", (t) => {
  const { repo, outside } = sandbox(t);
  const graft = join(repo, "graft");
  mkdirSync(graft);
  writeFileSync(join(graft, "real.md"), "---\nslug: real\nname: Real\n---\nREAL-NODE\n");
  writeFileSync(join(outside, "private.md"), "---\nslug: secret\nname: SECRET-NAME-789\n---\nSECRET-BODY-789\n");
  if (!linkFile(t, join(outside, "private.md"), join(graft, "secret.md"))) return;

  const graph = assembleContextGraph(graft);
  assert.deepEqual(graph.nodes.map((n) => n.id), ["real"]);
  assert.doesNotMatch(JSON.stringify(graph), /SECRET-(NAME|BODY)-789/);

  rmSync(graft, { recursive: true });
  linkDir(outside, graft);
  assert.throws(() => assembleContextGraph(graft), /symlink/);
});

test("graph, ask-index and manifest readers never read a symlinked sidecar", async (t) => {
  const { repo, outside } = sandbox(t);
  await buildGraph(repo);
  const outDir = join(repo, "graft");
  const leaves = {
    graph: join(outDir, ".graph", "wiring.json"),
    index: join(outDir, ".cache", "ask-index.json"),
    manifest: join(outDir, "manifest.json"),
  };
  const foreign = join(outside, "foreign.json");
  writeFileSync(foreign, JSON.stringify({ version: 1, nodes: [], edges: [], meta: { marker: "FOREIGN" }, files: [] }));
  for (const leaf of Object.values(leaves)) {
    rmSync(leaf, { force: true });
    if (!linkFile(t, foreign, leaf)) return;
  }
  assert.equal(loadGraphCached(outDir), null);
  assert.equal(readGraph(leaves.graph, repo), null);
  assert.equal(readAskIndex(outDir), null);
  assert.equal(readManifest(outDir), undefined);
});

test("a --dir inside the repo under a symlinked directory is refused by build and query", async (t) => {
  const { repo, outside } = sandbox(t);
  linkDir(outside, join(repo, "tools"));
  // The CLI resolves a relative `--dir tools/ctx` against the repo to this path.
  const contextDir = join(repo, "tools", "ctx");
  await assert.rejects(buildGraph(repo, { contextDir }), /symlink/);
  assert.throws(() => ask(repo, QUERY, { contextDir }), /symlink/);
  assert.deepEqual(readdirSync(outside), []);
});

test("freshness and extract caches are never read through a symlink", async (t) => {
  const { repo, outside } = sandbox(t);
  await buildGraph(repo);
  const outDir = join(repo, "graft");
  assert.ok(readFingerprint(outDir) && Object.keys(readExtractCache(outDir).files).length > 0);
  // Move each real sidecar outside and leave a link in its place: still valid
  // content, so only the containment check can make the reader refuse it.
  for (const leaf of [fingerprintPath(outDir), extractCachePath(outDir)!]) {
    const moved = join(outside, basename(leaf));
    renameSync(leaf, moved);
    if (!linkFile(t, moved, leaf)) return;
  }
  assert.equal(readFingerprint(outDir), null);
  assert.deepEqual(readExtractCache(outDir).files, {});
});

/** A parent checkout with a built-looking `graft/` and one linked worktree, by hand. */
function worktreePair(t: TestContext): { main: string; wt: string; outside: string } {
  const { repo: main, outside } = sandbox(t);
  const wt = join(outside, "..", "wt");
  const gitdir = join(main, ".git", "worktrees", "w");
  mkdirSync(gitdir, { recursive: true });
  writeFileSync(join(gitdir, "commondir"), "../..\n");
  mkdirSync(wt);
  writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}\n`);
  mkdirSync(join(main, "graft", ".graph"), { recursive: true });
  mkdirSync(join(main, "graft", ".cache"), { recursive: true });
  writeFileSync(join(main, "graft", ".graph", "wiring.json"), '{"version":1,"nodes":[],"edges":[],"meta":{}}');
  writeFileSync(fingerprintPath(join(main, "graft")), '{"version":1}');
  return { main, wt, outside };
}

test("worktree seeding never copies through a symlinked graft/.cache", (t) => {
  const { wt, outside } = worktreePair(t);
  mkdirSync(join(wt, "graft"));
  linkDir(outside, join(wt, "graft", ".cache"));

  assert.equal(seedGraph(wt).seeded, false);
  assert.deepEqual(readdirSync(outside), []);
});

test("worktree seeding never copies a symlinked source graph into the worktree", (t) => {
  const { main, wt, outside } = worktreePair(t);
  const foreign = join(outside, "foreign.json");
  writeFileSync(foreign, '{"version":1,"nodes":[],"edges":[],"meta":{"marker":"FOREIGN"}}');
  const srcGraph = join(main, "graft", ".graph", "wiring.json");
  rmSync(srcGraph);
  if (!linkFile(t, foreign, srcGraph)) return;

  assert.equal(seedGraph(wt).seeded, false);
  assert.ok(!existsSync(join(wt, "graft", ".graph", "wiring.json")));
});

test("a seeded worktree still gets the parent's graph and sidecars", (t) => {
  const { main, wt } = worktreePair(t);
  assert.equal(seedGraph(wt).seeded, true);
  assert.equal(
    readFileSync(join(wt, "graft", ".graph", "wiring.json"), "utf8"),
    readFileSync(join(main, "graft", ".graph", "wiring.json"), "utf8"),
  );
  assert.ok(existsSync(fingerprintPath(join(wt, "graft"))));
});

test("a repo-internal --dir or GRAFT_DIR may not pass through a symlinked directory", (t) => {
  const { repo, outside } = sandbox(t);
  linkDir(outside, join(repo, "tools"));
  assert.throws(() => contextDirFor(repo, join(repo, "tools", "ctx")), /symlink/);
  const saved = process.env.GRAFT_DIR;
  process.env.GRAFT_DIR = join("tools", "ctx");
  try {
    assert.throws(() => resolveContextDir(repo), /symlink/);
  } finally {
    if (saved === undefined) delete process.env.GRAFT_DIR;
    else process.env.GRAFT_DIR = saved;
  }
  assert.equal(contextDirFor(repo, join(repo, "real", "ctx")), join(repo, "real", "ctx"), "a missing path is fine");
});

test("a relative, nested --dir resolves where it did before", async (t) => {
  const { repo } = sandbox(t);
  const contextDir = relative(process.cwd(), join(repo, "out", "ctx"));
  await buildGraph(repo, { contextDir, graphOnly: true });
  assert.ok(existsSync(join(repo, "out", "ctx", ".graph", "wiring.json")));
});

test("a symlinked .graft never redirects or supplies the repo's build config", (t) => {
  const { repo, outside } = sandbox(t);
  writeFileSync(join(outside, "config.json"), JSON.stringify({ brain: { brainId: "x", token: "t", baseUrl: "http://attacker" } }));
  const before = snapshot(outside);
  linkDir(outside, join(repo, ".graft"));
  assert.equal(readBuildConfig(repo), null);
  assert.throws(() => patchBuildConfig(repo, { includeDirs: ["vendor"] }), /symlink/);
  assert.deepEqual(snapshot(outside), before);
});

test("the sync lock is never taken or cleared through a symlinked graft/.cache", (t) => {
  const { repo, outside } = sandbox(t);
  const stale = join(outside, ".sync.lock");
  writeFileSync(stale, "OUTSIDE");
  utimesSync(stale, new Date(2020, 0, 1), new Date(2020, 0, 1));
  mkdirSync(join(repo, "graft"));
  linkDir(outside, join(repo, "graft", ".cache"));
  const cache = join(repo, "graft", ".cache");

  assert.equal(acquireLockIn(cache), false);
  releaseLockIn(cache);
  assert.equal(readFileSync(stale, "utf8"), "OUTSIDE");
});

test("a workspace index naming anything but a plain, real child is foreign", (t) => {
  const { repo, outside } = sandbox(t);
  mkdirSync(join(repo, "a"));
  mkdirSync(join(repo, "graft"));
  const index = (children: string[]): void =>
    writeFileSync(join(repo, "graft", "workspace.json"), JSON.stringify({ version: 1, children }));
  index(["a"]);
  assert.deepEqual(readWorkspace(repo)?.children, ["a"]);
  for (const bad of [["../outside"], ["a/b"], ["a\\b"], [".."], ["c:x"]]) {
    index(bad);
    assert.equal(readWorkspace(repo), null, JSON.stringify(bad));
  }
  linkDir(outside, join(repo, "linked"));
  index(["a", "linked"]);
  assert.equal(readWorkspace(repo), null, "a symlinked child");
  rmSync(join(repo, "graft", "workspace.json"));
  writeFileSync(join(outside, "ws.json"), JSON.stringify({ version: 1, children: ["a"] }));
  if (!linkFile(t, join(outside, "ws.json"), join(repo, "graft", "workspace.json"))) return;
  assert.equal(readWorkspace(repo), null, "a symlinked index");
});

test("graft build refuses a repo whose committed .trail links out, and writes nothing there", async (t) => {
  const { repo, outside } = sandbox(t);
  mkdirSync(join(outside, "learnings"));
  linkDir(outside, join(repo, ".trail"));
  await assert.rejects(buildGraph(repo), /symlink/);
  assert.deepEqual(readdirSync(outside), ["learnings"]);
});

test("graft build refuses a symlinked .trail/cache", async (t) => {
  const { repo, outside } = sandbox(t);
  mkdirSync(join(repo, ".trail", "learnings"), { recursive: true });
  linkDir(outside, join(repo, ".trail", "cache"));
  await assert.rejects(buildGraph(repo), /symlink/);
  assert.deepEqual(readdirSync(outside), []);
});
