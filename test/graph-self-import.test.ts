import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph } from "../src/graph/build.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

interface Graph {
  edges: { relation: string; source: string; target: string; confidence: string }[];
  unresolvedCalls?: { source: string; name: string; through: string | null }[];
}

async function build(t: { after: (f: () => void) => void }, files: Record<string, string>): Promise<Graph> {
  const root = mkdtempSync(join(tmpdir(), "self-import-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  await buildGraph(root);
  return JSON.parse(readFileSync(join(root, "graft", ".graph", "wiring.json"), "utf8"));
}

const calls = (graph: Graph, source: string) =>
  graph.edges.filter((e) => e.relation === "calls" && e.source === source).map((e) => e.target).sort();

const decoy = "export function setCookie() {}\nexport function stream() {}\nexport function make() {}\n";

test("a package's own name reaches its source through `exports`, at the root and in a workspace", async (t) => {
  const graph = await build(t, {
    "package.json": JSON.stringify({
      name: "hono",
      exports: {
        ".": { import: "./dist/index.js" },
        "./cookie": { types: "./dist/types/helper/cookie/index.d.ts", import: "./dist/helper/cookie/index.js", require: "./dist/cjs/helper/cookie/index.js" },
        "./streaming": "./dist/helper/streaming/index.js",
      },
    }),
    "src/index.ts": "export function make() {}\n",
    "src/helper/cookie/index.ts": "export function setCookie() {}\n",
    "src/helper/streaming/index.ts": "export function stream() {}\n",
    "src/decoy.ts": decoy,
    "adapters/lambda/a.ts": `import { make } from "hono";\nimport { setCookie } from "hono/cookie";\nimport { stream } from "hono/streaming";\nexport function run() { make(); setCookie(); stream(); }\n`,
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", exports: { "./deep": { default: "./lib/deep/entry.mjs" }, "./feat/*": "./dist/feat/*.js" } }),
    "packages/core/src/deep/entry.ts": "export function dig() {}\n",
    "packages/core/src/feat/one.ts": "export function one() {}\n",
    "packages/other/x.ts": "export function dig() {}\nexport function one() {}\n",
    "apps/b.ts": `import { dig } from "@acme/core/deep";\nimport { one } from "@acme/core/feat/one";\nexport function run() { dig(); one(); }\n`,
  });
  assert.deepEqual(calls(graph, "adapters/lambda/a.ts#run"), ["src/helper/cookie/index.ts#setCookie", "src/helper/streaming/index.ts#stream", "src/index.ts#make"]);
  assert.deepEqual(calls(graph, "apps/b.ts#run"), ["packages/core/src/deep/entry.ts#dig", "packages/core/src/feat/one.ts#one"]);
});

const edge = (graph: Graph, source: string) =>
  graph.edges.filter((e) => e.relation === "calls" && e.source === source).map((e) => [e.target, e.confidence]);

test("a stub the manifest points at does not stop the search (vue)", async (t) => {
  const stub = `'use strict'\nmodule.exports = require('./dist/shared.cjs.js')\n`;
  const graph = await build(t, {
    "packages/shared/package.json": JSON.stringify({ name: "@vue/shared", main: "index.js", exports: { ".": { node: { default: "./index.js" }, import: "./dist/shared.esm.js", require: "./index.js" } } }),
    "packages/shared/index.js": stub,
    "packages/shared/src/index.ts": `export * from "./general";\n`,
    "packages/shared/src/general.ts": "export function isArray() {}\n",
    "packages/other/x.ts": "export function isArray() {}\n",
    "apps/a.ts": `import { isArray } from "@vue/shared";\nexport function run() { isArray(); }\n`,
  });
  assert.deepEqual(edge(graph, "apps/a.ts#run"), [["packages/shared/src/general.ts#isArray", "extracted"]]);
});

test("without `exports`, a workspace package's `main` reaches its source", async (t) => {
  const graph = await build(t, {
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", main: "lib/entry.js" }),
    "packages/core/src/entry.ts": "export function make() {}\n",
    "packages/other/x.ts": "export function make() {}\n",
    "apps/a.ts": `import { make } from "@acme/core";\nexport function run() { make(); }\n`,
  });
  assert.deepEqual(edge(graph, "apps/a.ts#run"), [["packages/core/src/entry.ts#make", "extracted"]]);
});

test("a name no path reaches is found inside its package and marked inferred; a wildcard path reaches its own", async (t) => {
  const graph = await build(t, {
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", exports: { "./features/*": "./dist/impl/*.js", "./gen": "./generated/gen.js" } }),
    "packages/core/src/impl/one.ts": "export function one() {}\n",
    "packages/core/src/gen-source.ts": "export function gen() {}\n",
    "packages/other/x.ts": "export function one() {}\nexport function gen() {}\n",
    "apps/a.ts": `import { one } from "@acme/core/features/one";\nimport { gen } from "@acme/core/gen";\nexport function run() { one(); gen(); }\n`,
  });
  assert.deepEqual(edge(graph, "apps/a.ts#run").sort(), [
    ["packages/core/src/gen-source.ts#gen", "inferred"],
    ["packages/core/src/impl/one.ts#one", "extracted"],
  ]);
});

test("the repo's own import that nothing in its package defines is reported, and an outside one stays silent", async (t) => {
  const graph = await build(t, {
    "package.json": JSON.stringify({ name: "hono", exports: { "./gen": "./generated/gen.js" } }),
    "packages/twice/package.json": JSON.stringify({ name: "twice" }),
    "packages/twice/a.ts": "export function both() {}\n",
    "packages/twice/b.ts": "export function both() {}\n",
    "src/decoy.ts": "export function ext() {}\n",
    "a.ts": `import { gen } from "hono/gen";\nimport { ext } from "other-pkg/sub";\nimport * as K from "hono/nope";\nimport { both } from "twice";\nexport function run() { gen(); ext(); K.ns(); both(); }\n`,
  });
  assert.deepEqual(calls(graph, "a.ts#run"), [], "no guess at the decoy");
  assert.deepEqual((graph.unresolvedCalls ?? []).filter((u) => u.source === "a.ts#run").map((u) => [u.name, u.through]).sort(), [
    ["both", "twice"],
    ["gen", "hono/gen"],
    ["ns", "hono/nope"],
  ]);
});

test("`baseUrl` without `paths` is in the repo when the first segment is under it, and outside when not", async (t) => {
  const graph = await build(t, {
    "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "./src" } }),
    "src/lib/util.ts": "export function f() {}\n",
    "z/other.ts": "export function f() {}\nexport function ext() {}\nexport function gone() {}\n",
    "a.ts": `import { f } from "lib/util";\nimport { ext } from "lodash";\nimport { gone } from "lib/gone";\nexport function run() { f(); ext(); gone(); }\n`,
  });
  assert.deepEqual(calls(graph, "a.ts#run"), ["src/lib/util.ts#f"]);
  assert.deepEqual((graph.unresolvedCalls ?? []).filter((u) => u.source === "a.ts#run").map((u) => u.name), ["gone"]);
});

test("Python: an absolute import of the repo's own package finds its module", async (t) => {
  const graph = await build(t, {
    "mypkg/__init__.py": "",
    "mypkg/b.py": "def f():\n    pass\n",
    "other/__init__.py": "",
    "other/c.py": "def f():\n    pass\n",
    "mypkg/a.py": "from mypkg.b import f\n\ndef run():\n    f()\n",
  });
  assert.deepEqual(calls(graph, "mypkg/a.py#run"), ["mypkg/b.py#f"]);
});

test("Rust: `crate::` and a workspace member's own name both reach it", async (t) => {
  const graph = await build(t, {
    "Cargo.toml": `[workspace]\nmembers = ["crates/*"]\n`,
    "crates/grep-printer/Cargo.toml": `[package]\nname = "grep-printer"\n`,
    "crates/grep-printer/src/lib.rs": "pub mod util;\npub fn run() { crate::util::f(); }\n",
    "crates/grep-printer/src/util.rs": "pub fn f() {}\n",
    "crates/app/Cargo.toml": `[package]\nname = "app"\n[dependencies]\ngrep-printer = "1"\n`,
    "crates/app/src/main.rs": "use grep_printer::util::f;\nfn main() { f(); }\n",
  });
  assert.deepEqual(calls(graph, "crates/grep-printer/src/lib.rs#run"), ["crates/grep-printer/src/util.rs#f"]);
  assert.deepEqual(calls(graph, "crates/app/src/main.rs#main"), ["crates/grep-printer/src/util.rs#f"]);
});

const types = "pub struct One;\npub struct Two;\nimpl One { pub fn go() {} }\nimpl Two { pub fn run() {} }\n";

test("Rust: an alias reads in its inline module, so 2 modules may share its name", async (t) => {
  const graph = await build(t, {
    "src/t.rs": types,
    "src/a.rs": "mod a { type R = crate::t::One; pub fn x() { R::go(); } }\nmod b { type R = crate::t::Two; pub fn y() { R::run(); } }\n",
  });
  assert.equal(calls(graph, "src/a.rs#x").length, 1, "the first module's alias");
  assert.equal(calls(graph, "src/a.rs#y").length, 1, "the second module's alias");
});

test("Rust: an alias names its crate, which picks between the repo's types of that name (ripgrep's Range)", async (t) => {
  const graph = await build(t, {
    "crates/matcher/Cargo.toml": `[package]\nname = "grep-matcher"\n`,
    "crates/matcher/src/lib.rs": "pub struct Match;\nimpl Match { pub fn new() {} }\n",
    "crates/ignore/Cargo.toml": `[package]\nname = "ignore"\n`,
    "crates/ignore/src/lib.rs": "pub struct Match;\nimpl Match { pub fn new() {} }\n",
    "crates/searcher/Cargo.toml": `[package]\nname = "grep-searcher"\n[dependencies]\ngrep-matcher = { path = "../matcher" }\n`,
    "crates/searcher/src/lib.rs": "use grep_matcher::Match;\npub type Range = Match;\n",
    "crates/searcher/src/core.rs": "use crate::Range;\nfn f() { Range::new(); }\n",
  });
  assert.deepEqual(calls(graph, "crates/searcher/src/core.rs#f").map((x) => x.split("#")[0]), ["crates/matcher/src/lib.rs"]);
});

test("Rust: an alias of a dependency's type stops there, and a type only a macro makes is stated", async (t) => {
  const graph = await build(t, {
    "Cargo.toml": `[package]\nname = "app"\n[dependencies]\nhttp = "1"\n`,
    "src/lib.rs": "pub struct Other;\nimpl Other { pub fn from_err() {} pub fn builder() {} }\ndefine!(MadeByMacro);\n",
    "src/a.rs": "type Req = http::Request;\npub fn up() { Req::builder(); }\npub fn made() { MadeByMacro::from_err(); }\n",
  });
  assert.deepEqual(calls(graph, "src/a.rs#up"), []);
  const stated = (graph.unresolvedCalls ?? []).filter((u) => u.source.startsWith("src/a.rs")).map((u) => [u.source, u.name, u.through]);
  assert.deepEqual(stated, [["src/a.rs#made", "from_err", "MadeByMacro"]]);
});

test("a relative import of a file the graph lacks, such as a build's, is reported with no guess", async (t) => {
  const graph = await build(t, {
    "src/effect.ts": "export function effect() {}\n",
    "bench/a.ts": `import { effect } from "../dist/reactivity";\nexport function run() { effect(); }\n`,
  });
  assert.deepEqual(calls(graph, "bench/a.ts#run"), []);
  assert.deepEqual((graph.unresolvedCalls ?? []).map((u) => [u.name, u.through]), [["effect", "../dist/reactivity"]]);
});

const stated = (graph: Graph, source: string) => (graph.unresolvedCalls ?? []).filter((u) => u.source === source).map((u) => [u.name, u.through]);

test("V3: an entry forwarding the name outside does not end the search past one defining it", async (t) => {
  const graph = await build(t, {
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", exports: { ".": { require: "./cjs/entry.cjs", import: "./esm/entry.js" } } }),
    "packages/core/cjs/entry.cjs": `export { run } from "outside-pkg";\n`,
    "packages/core/esm/entry.js": "export function run() {}\n",
    "packages/other/x.ts": "export function run() {}\n",
    "apps/a.ts": `import { run } from "@acme/core";\nexport function go() { run(); }\n`,
  });
  assert.deepEqual(calls(graph, "apps/a.ts#go"), ["packages/core/esm/entry.js#run"]);
  const out = await build(t, {
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", exports: { ".": "./cjs/entry.cjs" } }),
    "packages/core/cjs/entry.cjs": `export { run } from "outside-pkg";\n`,
    "packages/other/x.ts": "export function run() {}\n",
    "apps/a.ts": `import { run } from "@acme/core";\nexport function go() { run(); }\n`,
  });
  assert.deepEqual(calls(out, "apps/a.ts#go"), [], "only outside: T1 holds");
  assert.deepEqual(stated(out, "apps/a.ts#go"), []);
});

test("V2: a package name found outside its entries must be exported under that name", async (t) => {
  const renamed = await build(t, {
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", exports: { ".": "./dist/unmapped/entry.js" } }),
    "packages/core/src/barrel.ts": `export { execute as run } from "./impl";\n`,
    "packages/core/src/impl.ts": "export function execute() {}\n",
    "packages/core/src/other.ts": "export function run() {}\n",
    "apps/a.ts": `import { run } from "@acme/core";\nexport function go() { run(); }\n`,
  });
  assert.deepEqual(calls(renamed, "apps/a.ts#go"), [], "2 things export that name: no guess");
  assert.deepEqual(stated(renamed, "apps/a.ts#go"), [["run", "@acme/core"]]);
  const hidden = await build(t, {
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", exports: { ".": "./dist/unmapped/entry.js" } }),
    "packages/core/src/private.ts": "function run() {}\nrun();\n",
    "apps/a.ts": `import { run } from "@acme/core";\nexport function go() { run(); }\n`,
  });
  assert.deepEqual(calls(hidden, "apps/a.ts#go"), [], "a private function of that name proves nothing");
  assert.deepEqual(stated(hidden, "apps/a.ts#go"), [["run", "@acme/core"]]);
  const proven = await build(t, {
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", exports: { ".": "./dist/unmapped/entry.js" } }),
    "packages/core/src/barrel.ts": `export { execute as run } from "./impl";\n`,
    "packages/core/src/impl.ts": "export function execute() {}\n",
    "apps/a.ts": `import { run } from "@acme/core";\nexport function go() { run(); }\n`,
  });
  assert.deepEqual(edge(proven, "apps/a.ts#go"), [["packages/core/src/impl.ts#execute", "inferred"]], "the rename is the provenance");
});

test("V4: an `exports` wildcard substitutes by prefix and suffix", async (t) => {
  const graph = await build(t, {
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", exports: { "./api/*": "./dist/impl/*.js", "./v/*.js": "./dist/vers/*.js" } }),
    "packages/core/src/impl/one.ts": "export function f() {}\n",
    "packages/core/src/impl/two.ts": "export function f() {}\n",
    "packages/core/src/vers/three.ts": "export function g() {}\n",
    "packages/core/src/vers/four.ts": "export function g() {}\n",
    "apps/a.ts": `import { f } from "@acme/core/api/two";\nimport { g } from "@acme/core/v/three.js";\nexport function go() { f(); g(); }\n`,
  });
  assert.deepEqual(edge(graph, "apps/a.ts#go").sort(), [["packages/core/src/impl/two.ts#f", "extracted"], ["packages/core/src/vers/three.ts#g", "extracted"]]);
});

test("V5: an alias reaches another Rust module only through a `use`", async (t) => {
  const graph = await build(t, {
    "src/t.rs": "pub struct Match;\nimpl Match { pub fn run() {} }\n",
    "src/a.rs": "use crate::t::Match;\npub type Range = Match;\n",
    "src/sibling.rs": "fn f() { Range::run(); }\n",
    "src/user.rs": "use crate::a::Range;\nfn g() { Range::run(); }\n",
    "src/globbed.rs": "use crate::a::*;\nfn h() { Range::run(); }\n",
  });
  assert.deepEqual(calls(graph, "src/sibling.rs#f"), [], "nothing brings it in");
  assert.equal(calls(graph, "src/user.rs#g").length, 1, "a `use` does");
  assert.equal(calls(graph, "src/globbed.rs#h").length, 1, "a glob may");
});

test("U4: a child's `baseUrl` outranks the one it inherits", async (t) => {
  const graph = await build(t, {
    "tsconfig.base.json": JSON.stringify({ compilerOptions: { baseUrl: "./wrong", paths: { "~/*": ["./*"] } } }),
    "tsconfig.json": JSON.stringify({ extends: "./tsconfig.base.json", compilerOptions: { baseUrl: "./src" } }),
    "src/lib/util.ts": "export function f() {}\nexport function h() {}\n",
    "wrong/lib/util.ts": "export function f() {}\nexport function h() {}\n",
    "a.ts": `import { f } from "lib/util";\nimport { h } from "~/lib/util";\nexport function run() { f(); h(); }\n`,
  });
  assert.deepEqual(calls(graph, "a.ts#run"), ["src/lib/util.ts#f", "src/lib/util.ts#h"]);
});
