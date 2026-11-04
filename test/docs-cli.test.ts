/**
 * `trail docs` and `graft docs`: finding the gg-docs binary, the folder it
 * searches, the arguments it gets and the protocol check on its JSON; then the
 * real binary through both installed entry points. That last group runs when a
 * binary is found the normal way and skips otherwise, except with
 * GG_DOCS_E2E=require, which CI's gg-docs job sets after building one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DOCS_PROTOCOL, docsArgs, docsRoot, docsTarget, envelopeProblem, findDocsBinary } from "../src/docs/docs-cli.js";

function scratch(t: { after: (f: () => void) => void }, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return dir;
}

function touch(path: string, text = ""): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** A package tree with rust/gg-docs/VERSION, and the two places a linux binary can be. */
function pkg(t: { after: (f: () => void) => void }, version = "0.1.0") {
  const root = scratch(t, "docs-pkg-");
  const crate = join(root, "rust", "gg-docs");
  touch(join(crate, "VERSION"), `${version}\n`);
  return {
    root,
    prebuilt: (v = version, target = "x86_64-unknown-linux-musl", exe = "gg-docs") => join(crate, "prebuilt", v, target, exe),
    built: (exe = "gg-docs") => join(crate, "target", "release", exe),
  };
}

test("docsTarget: Windows MSVC and Linux musl on x64; none elsewhere", () => {
  assert.equal(docsTarget("win32", "x64"), "x86_64-pc-windows-msvc");
  assert.equal(docsTarget("linux", "x64"), "x86_64-unknown-linux-musl");
  assert.equal(docsTarget("linux", "arm64"), undefined);
  assert.equal(docsTarget("darwin", "arm64"), undefined);
  assert.equal(docsTarget("darwin", "x64"), undefined);
});

test("findDocsBinary: TRAIL_DOCS_BIN first, and a missing one is an error, not a fall-through", (t) => {
  const p = pkg(t);
  touch(p.prebuilt());
  const own = touch(join(p.root, "elsewhere", "my-gg-docs"));
  assert.deepEqual(findDocsBinary(p.root, { TRAIL_DOCS_BIN: own }, "linux", "x64"), { bin: own });
  const missing = findDocsBinary(p.root, { TRAIL_DOCS_BIN: join(p.root, "nope") }, "linux", "x64");
  assert.ok("error" in missing && missing.error.includes("TRAIL_DOCS_BIN names no file"));
});

test("findDocsBinary: the prebuilt copy for this VERSION, then a cargo build", (t) => {
  const p = pkg(t);
  touch(p.built());
  assert.deepEqual(findDocsBinary(p.root, {}, "linux", "x64"), { bin: p.built() });
  touch(p.prebuilt());
  assert.deepEqual(findDocsBinary(p.root, {}, "linux", "x64"), { bin: p.prebuilt() });
});

test("findDocsBinary: Windows looks for gg-docs.exe under its own target", (t) => {
  const p = pkg(t);
  touch(p.prebuilt("0.1.0", "x86_64-pc-windows-msvc", "gg-docs.exe"));
  assert.deepEqual(findDocsBinary(p.root, {}, "win32", "x64"), { bin: p.prebuilt("0.1.0", "x86_64-pc-windows-msvc", "gg-docs.exe") });
  assert.ok("error" in findDocsBinary(p.root, {}, "linux", "x64"), "a Windows copy is not a Linux one");
});

test("findDocsBinary: a copy for an older VERSION is not used, and the error names both places", (t) => {
  const p = pkg(t, "0.2.0");
  touch(p.prebuilt("0.1.0"));
  const found = findDocsBinary(p.root, {}, "linux", "x64");
  assert.ok("error" in found);
  assert.ok(found.error.includes(p.prebuilt("0.2.0")), found.error);
  assert.ok(found.error.includes(p.built()), found.error);
  assert.match(found.error, /cargo build --release --locked --manifest-path /);
  assert.match(found.error, /Or put a gg-docs 0\.2\.0 binary for x86_64-unknown-linux-musl/);
});

test("findDocsBinary: no prebuilt path on a platform without one, or with a VERSION that is not a version", (t) => {
  const p = pkg(t);
  const mac = findDocsBinary(p.root, {}, "darwin", "arm64");
  assert.ok("error" in mac);
  assert.ok(!mac.error.includes("prebuilt"), mac.error);
  assert.doesNotMatch(mac.error, /Or put a gg-docs/);
  touch(p.built());
  assert.deepEqual(findDocsBinary(p.root, {}, "darwin", "arm64"), { bin: p.built() });

  const odd = pkg(t, "../../escape");
  touch(join(odd.root, "rust", "escape", "x86_64-unknown-linux-musl", "gg-docs"));
  const found = findDocsBinary(odd.root, {}, "linux", "x64");
  assert.ok("error" in found && !found.error.includes("prebuilt"), "error" in found ? found.error : found.bin);
});

test("docsRoot: the folder named, else the enclosing checkout (said on stderr), else here", (t) => {
  const dir = scratch(t, "docs-root-");
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });
  mkdirSync(join(repo, "notes", "deep"), { recursive: true });
  const loose = join(dir, "loose");
  mkdirSync(loose);
  assert.deepEqual(docsRoot("somewhere", repo), { root: resolve("somewhere") });
  assert.deepEqual(docsRoot(undefined, repo), { root: repo });
  const deep = docsRoot(undefined, join(repo, "notes", "deep"));
  assert.equal(deep.root, repo);
  assert.match(deep.note ?? "", /searching the whole checkout at /);
  assert.deepEqual(docsRoot(undefined, loose, join(dir, "home")), { root: loose });
});

test("docsRoot: outside a checkout, the home folder or a drive's root needs --root", (t) => {
  const home = scratch(t, "docs-home-");
  const refused = docsRoot(undefined, home, home);
  assert.ok("error" in refused && refused.error.includes("cd into a repository, or name the folder with --root"));
  const top = resolve("/");
  assert.ok("error" in docsRoot(undefined, top, home), `${top} is a drive's root`);
  assert.deepEqual(docsRoot(home, home, home), { root: home }, "named, it is searched");
});

test("docsRoot: a git checkout at the home folder is refused too, from it or below it", (t) => {
  const home = scratch(t, "docs-home-git-");
  mkdirSync(join(home, ".git"));
  mkdirSync(join(home, "projects", "loose"), { recursive: true });
  for (const cwd of [home, join(home, "projects", "loose")]) {
    const refused = docsRoot(undefined, cwd, home);
    assert.ok("error" in refused && refused.error.includes(`${home} is the home folder`), JSON.stringify(refused));
  }
});

test("docsArgs: the protocol and root first; words and paths after --", () => {
  const head = ["--protocol", String(DOCS_PROTOCOL), "--root", "/r"];
  assert.deepEqual(docsArgs({ sub: "search", query: ["-n", "claims"], limit: "3", json: true }, "/r"), [
    ...head, "search", "-n", "3", "--json", "--", "-n", "claims",
  ]);
  assert.deepEqual(docsArgs({ sub: "search", query: ["claims"] }, "/r"), [...head, "search", "--", "claims"]);
  assert.deepEqual(docsArgs({ sub: "get", path: "-odd.md", from: "2", lines: "5" }, "/r"), [
    ...head, "get", "--from", "2", "--lines", "5", "--", "-odd.md",
  ]);
  assert.deepEqual(docsArgs({ sub: "status", json: true }, "/r"), [...head, "status", "--json"]);
  assert.deepEqual(docsArgs({ sub: "update" }, "/r"), [...head, "update"]);
});

test("envelopeProblem: only an object carrying this protocol passes", () => {
  assert.equal(envelopeProblem('{"protocol":1,"hits":[]}\n'), undefined);
  assert.match(envelopeProblem('{"protocol":2,"hits":[]}') ?? "", /protocol 2, but .* reads protocol 1/);
  assert.match(envelopeProblem('{"hits":[]}') ?? "", /protocol \(none\)/);
  assert.match(envelopeProblem('[{"path":"a.md"}]') ?? "", /protocol \(none\)/, "the pre-protocol bare array");
  assert.match(envelopeProblem("a.md:1  Claims") ?? "", /did not answer with JSON/);
});

// --- the real binary, through dist/bin/trail.js and dist/bin/graft.js ---

const repoRoot = resolve(".");
const found = findDocsBinary(repoRoot);
const entries = ["trail", "graft"].map((b) => join(repoRoot, "dist", "bin", `${b}.js`));
const missing = "error" in found ? "no gg-docs binary" : entries.find((e) => !existsSync(e)) ? "no dist/ build" : undefined;
const required = process.env.GG_DOCS_E2E === "require";
const e2e = { skip: missing !== undefined && !required ? `${missing}; GG_DOCS_E2E=require makes this fail instead` : false };

function e2eScene(t: { after: (f: () => void) => void }) {
  assert.equal(missing, undefined, `GG_DOCS_E2E=require, but there is ${missing}`);
  const dir = scratch(t, "docs-e2e-");
  const repo = join(dir, "repo");
  touch(join(repo, "notes", "claims.md"), "# Claims\n\nA claim lapses after four hours.\n");
  touch(join(repo, "README.md"), "# Fixture\n\nNothing about the subject here.\n");
  execFileSync("git", ["init", "-q", repo]);
  const trailHome = join(dir, "trail-home");
  const env = { ...process.env, TRAIL_HOME: trailHome, DO_NOT_TRACK: "1" };
  const run = (entry: "trail" | "graft", cwd: string, ...args: string[]) =>
    spawnSync(process.execPath, [entries[entry === "trail" ? 0 : 1], "docs", ...args], { cwd, env, encoding: "utf8" });
  return { dir, repo, trailHome, run };
}

test("e2e: trail docs search from inside a checkout searches all of it", e2e, (t) => {
  const { repo, trailHome, run } = e2eScene(t);
  const r = run("trail", join(repo, "notes"), "search", "claim", "lapses");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout.split("\n")[0], /^notes\/claims\.md:1\b/);
  assert.match(r.stderr, /searching the whole checkout at /);
  assert.equal(readdirSync(join(trailHome, "docs")).filter((f) => f.endsWith(".turso")).length, 1, "the index lives under TRAIL_HOME");
});

test("e2e: graft docs --json answers carry the protocol, and --root needs no note", e2e, (t) => {
  const { dir, repo, run } = e2eScene(t);
  const search = run("graft", dir, "search", "claim", "lapses", "--json", "--root", repo);
  assert.equal(search.status, 0, search.stderr);
  assert.equal(search.stderr, "");
  const hits = JSON.parse(search.stdout);
  assert.equal(hits.protocol, DOCS_PROTOCOL);
  assert.equal(hits.hits[0].path, "notes/claims.md");

  touch(join(repo, "notes", "more.md"), "# More\n\nAnother note.\n");
  const update = JSON.parse(run("graft", repo, "update", "--json").stdout);
  assert.deepEqual([update.protocol, update.added], [DOCS_PROTOCOL, 1]);
  const status = JSON.parse(run("trail", repo, "status", "--json").stdout);
  assert.deepEqual([status.protocol, status.documents], [DOCS_PROTOCOL, 3]);
});

test("e2e: docs get prints lines; errors keep the binary's exit code", e2e, (t) => {
  const { repo, run } = e2eScene(t);
  const got = run("trail", repo, "get", "notes/claims.md", "--from", "3", "-l", "1");
  assert.equal(got.status, 0, got.stderr);
  assert.equal(got.stdout.replace(/\r\n/g, "\n"), "A claim lapses after four hours.\n");
  const absent = run("trail", repo, "get", "missing.md");
  assert.equal(absent.status, 1);
  assert.match(absent.stderr, /^gg-docs: missing\.md:/m);
  const bad = run("graft", repo, "search", "claim", "--limit", "0");
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--limit must be a positive whole number, got "0"/);
});
