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

test("a name no path reaches is found inside its package and marked inferred, whatever the map says", async (t) => {
  const graph = await build(t, {
    "packages/core/package.json": JSON.stringify({ name: "@acme/core", exports: { "./features/*": "./dist/impl/*.js", "./gen": "./generated/gen.js" } }),
    "packages/core/src/impl/one.ts": "export function one() {}\n",
    "packages/core/src/gen-source.ts": "export function gen() {}\n",
    "packages/other/x.ts": "export function one() {}\nexport function gen() {}\n",
    "apps/a.ts": `import { one } from "@acme/core/features/one";\nimport { gen } from "@acme/core/gen";\nexport function run() { one(); gen(); }\n`,
  });
  assert.deepEqual(edge(graph, "apps/a.ts#run").sort(), [
    ["packages/core/src/gen-source.ts#gen", "inferred"],
    ["packages/core/src/impl/one.ts#one", "inferred"],
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
