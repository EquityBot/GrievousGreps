import { test } from "node:test";
import assert from "node:assert/strict";
import { warmDepthGrammars } from "../src/graph/depth-parser.js";
import { extractFile } from "../src/graph/extract.js";
import { resolveEdges } from "../src/graph/resolve.js";
import { buildGraph } from "../src/graph/build.js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

await warmDepthGrammars(["typescript", "tsx"]);

function calls(files: Record<string, string>, source: string): string[] {
  const extracted = Object.entries(files).map(([path, text]) => extractFile(path, text, path.endsWith("x") ? "tsx" : "typescript"));
  return resolveEdges(extracted.flatMap((x) => x.nodes), extracted.flatMap((x) => x.rawEdges), {})
    .filter((e) => e.relation === "calls" && e.source === source)
    .map((e) => e.target)
    .sort();
}

// Two definitions of each name, so the global name lookup alone cannot choose.
const defs = {
  "a/impl.ts": "export function f() {}\nexport function g() {}\nexport default function dflt() {}\n",
  "z/other.ts": "export function f() {}\nexport function g() {}\nexport function dflt() {}\n",
};
const consumer = (text: string) => ({ ...defs, "c/use.ts": text });

test("a bare call follows its named import when the name alone is ambiguous", () => {
  assert.deepEqual(calls(consumer(`import { f } from "../a/impl";\nexport function run() { f(); }\n`), "c/use.ts#run"), ["a/impl.ts#f"]);
  assert.deepEqual(calls(consumer(`import { g as f } from "../a/impl.js";\nexport function run() { f(); }\n`), "c/use.ts#run"), ["a/impl.ts#g"], "an import rename, and a .js specifier");
  assert.deepEqual(calls(consumer(`import d from "../a/impl";\nexport function run() { d(); }\n`), "c/use.ts#run"), ["a/impl.ts#dflt"], "a default import");
  assert.deepEqual(calls(consumer(`import { default as d } from "../a/impl";\nexport function run() { d(); }\n`), "c/use.ts#run"), ["a/impl.ts#dflt"], "default by name");
});

test("`./` and `../` name the folder's index, as `.` and `..` do", () => {
  const files = (spec: string, at: string) => ({ ...defs, "a/index.ts": `export { f } from "./impl";\n`, [at]: `import { f } from "${spec}";\nexport function run() { f(); }\n` });
  assert.deepEqual(calls(files("./", "a/use.ts"), "a/use.ts#run"), ["a/impl.ts#f"]);
  assert.deepEqual(calls(files("../", "a/b/use.ts"), "a/b/use.ts#run"), ["a/impl.ts#f"]);
  assert.deepEqual(calls(files(".", "a/use.ts"), "a/use.ts#run"), ["a/impl.ts#f"]);
});

test("a call chases barrels and export renames to the definition", () => {
  const barrels = {
    ...defs,
    "b/one.ts": `export { g as f } from "../a/impl";\n`,
    "b/two.ts": `import { f as local } from "./one";\nexport { local as h };\n`,
    "b/star.ts": `export * from "./two";\n`,
    "c/use.ts": `import { h } from "../b/star";\nexport function run() { h(); }\n`,
  };
  assert.deepEqual(calls(barrels, "c/use.ts#run"), ["a/impl.ts#g"]);
  const named = { "a/n.ts": "function inner() {}\nexport { inner as outer };\nexport default inner;\n", "z/n.ts": "export function outer() {}\nexport function inner() {}\n" };
  assert.deepEqual(calls({ ...named, "c/use.ts": `import { outer } from "../a/n";\nexport function run() { outer(); }\n` }, "c/use.ts#run"), ["a/n.ts#inner"], "a local export rename");
  assert.deepEqual(calls({ ...named, "c/use.ts": `import d from "../a/n";\nexport function run() { d(); }\n` }, "c/use.ts#run"), ["a/n.ts#inner"], "export default of a name");
});

test("an export cycle or a star conflict states no target", () => {
  const cycle = { ...defs, "b/x.ts": `export { f } from "./y";\n`, "b/y.ts": `export { f } from "./x";\n`, "c/use.ts": `import { f } from "../b/x";\nexport function run() { f(); }\n` };
  assert.deepEqual(calls(cycle, "c/use.ts#run"), []);
  const conflict = { ...defs, "b/s.ts": `export * from "../a/impl";\nexport * from "../z/other";\n`, "c/use.ts": `import { f } from "../b/s";\nexport function run() { f(); }\n` };
  assert.deepEqual(calls(conflict, "c/use.ts#run"), []);
  const stardefault = { ...defs, "b/s.ts": `export * from "../a/impl";\n`, "c/use.ts": `import d from "../b/s";\nexport function run() { d(); }\n` };
  assert.deepEqual(calls(stardefault, "c/use.ts#run"), [], "export * carries no default");
});

test("no import that binds the name keeps today's name lookup", () => {
  const one = { "a/only.ts": "export function solo() {}\n" };
  assert.deepEqual(calls({ ...one, "c/use.ts": `export function run() { solo(); }\n` }, "c/use.ts#run"), ["a/only.ts#solo"], "no import");
  assert.deepEqual(calls({ ...one, "c/use.ts": `import { solo } from "./x";\nexport function run(solo: () => void) { solo(); }\n`, "c/x.ts": "export function solo() {}\n" }, "c/use.ts#run"), [], "a parameter that shadows it, with the name ambiguous");
  const shadow = { ...defs, "c/use.ts": `import { f } from "../a/impl";\nexport function run() { const f = () => 1; f(); }\n` };
  assert.deepEqual(calls(shadow, "c/use.ts#run"), ["c/use.ts#run.f"], "a local that shadows it");
  assert.deepEqual(calls({ ...defs, "c/use.ts": `export function own() {}\nimport { f } from "../a/impl";\nexport function run() { own(); }\n` }, "c/use.ts#run"), ["c/use.ts#own"], "another name in the same file");
});

test("a namespace import reaches the module's export", () => {
  const ns = (text: string) => ({ ...defs, "b/i.ts": `export { g as f } from "../a/impl";\n`, "b/sp.ts": `export * as sub from "../a/impl";\n`, "c/use.ts": text });
  assert.deepEqual(calls(ns(`import * as NS from "../a/impl";\nexport function run() { NS.f(); }\n`), "c/use.ts#run"), ["a/impl.ts#f"]);
  assert.deepEqual(calls(ns(`import * as NS from "../b/i";\nexport function run() { NS.f(); }\n`), "c/use.ts#run"), ["a/impl.ts#g"], "through a barrel");
  assert.deepEqual(calls(ns(`import * as NS from "../b/sp";\nexport function run() { NS.sub.g(); }\n`), "c/use.ts#run"), ["a/impl.ts#g"], "through export * as");
  assert.deepEqual(calls(ns(`import { sub } from "../b/sp";\nexport function run() { sub.g(); }\n`), "c/use.ts#run"), ["a/impl.ts#g"], "a named module");
  assert.deepEqual(calls(ns(`import * as NS from "../a/impl";\nexport function run(NS: any) { NS.f(); }\n`), "c/use.ts#run"), [], "a parameter that shadows it");
  assert.deepEqual(calls(ns(`import * as NS from "external";\nexport function run() { NS.f(); }\n`), "c/use.ts#run"), [], "a module from outside");
});

test("an overloaded interface with a line-leading generic does not lose the file after it", () => {
  const text = [
    "export interface Make<E> {",
    "  <I>(h: H): [H]",
    "  <",
    "    I,",
    "    I2,",
    "    R,",
    "    E2,",
    "    E3 = N<[E, E2]>,",
    "  >(",
    "    a: H,",
    "    b: H",
    "  ): [H, H]",
    "}",
    "",
    "export class Factory {",
    "  build() {",
    "    return helper();",
    "  }",
    "}",
    "",
    "export const createFactory = () => new Factory();",
    "function helper() {}",
    "",
  ].join("\n");
  const out = extractFile("factory.ts", text, "typescript");
  const ids = out.nodes.map((n) => n.id);
  for (const id of ["factory.ts#Factory", "factory.ts#createFactory", "factory.ts#helper"]) assert.ok(ids.includes(id), id);
  const factory = out.nodes.find((n) => n.id === "factory.ts#Factory")!;
  assert.match(factory.span ?? "", /^L15/, "lines stay where they were");
  // A file that stays broken keeps its own parse rather than a guess.
  const broken = extractFile("b.ts", "export function ok() {}\n  <T>(\nfunction (\n", "typescript");
  assert.ok(broken.nodes.some((n) => n.id === "b.ts#ok"));
});

test("a JSX element follows its import like a call", () => {
  const widgets = { "a/w.tsx": "export function Card() { return null; }\n", "z/w.tsx": "export function Card() { return null; }\n", "b/i.ts": `export { Card as Panel } from "../a/w";\n` };
  assert.deepEqual(calls({ ...widgets, "c/p.tsx": `import { Panel } from "../b/i";\nexport function Page() { return <Panel />; }\n` }, "c/p.tsx#Page"), ["a/w.tsx#Card"]);
});

test("an import through a tsconfig path alias reaches the in-repo export", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "ts-paths-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files: Record<string, string> = {
    // A comment, a `/*` inside a string and a trailing comma, as a real tsconfig has them.
    "tsconfig.json": `{\n  /* compiler */\n  "compilerOptions": {\n    "paths": {\n      "pkg": ["./src/index.ts"],\n      "pkg/*": ["./src/*.ts"], // subpaths\n    },\n  },\n}\n`,
    "src/internals.ts": "function build() {}\nexport { build as INTERNAL_build };\n",
    "src/index.ts": "export function top() {}\n",
    "other/internals.ts": "export function build() {}\nexport function top() {}\n",
    "tests/a.test.ts": `import { INTERNAL_build as make } from "pkg/internals";\nexport function run() { make(); }\n`,
    "tests/b.test.ts": `import { top } from "pkg";\nexport function go() { top(); }\n`,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  await buildGraph(root);
  const graph = JSON.parse(readFileSync(join(root, "graft", ".graph", "wiring.json"), "utf8"));
  const from = (source: string) => graph.edges.filter((e: { relation: string; source: string }) => e.relation === "calls" && e.source === source).map((e: { target: string }) => e.target);
  assert.deepEqual(from("tests/a.test.ts#run"), ["src/internals.ts#build"]);
  assert.deepEqual(from("tests/b.test.ts#go"), ["src/index.ts#top"]);
});

test("an import names the target: outside the repo or unreadable, no name lookup guesses one", () => {
  const one = { "a/only.ts": "export function solo() {}\n" };
  for (const spec of ["pkg", "@acme/alias", "./missing"]) {
    assert.deepEqual(calls({ ...one, "c/use.ts": `import { solo } from "${spec}";\nexport function run() { solo(); }\n` }, "c/use.ts#run"), [], spec);
    assert.deepEqual(calls({ ...one, "c/use.ts": `import solo from "${spec}";\nexport function run() { solo(); }\n` }, "c/use.ts#run"), [], `default from ${spec}`);
  }
  assert.deepEqual(calls({ ...one, "c/use.ts": `import { other } from "pkg";\nexport function run() { solo(); other(); }\n` }, "c/use.ts#run"), ["a/only.ts#solo"], "a name no import binds keeps the lookup");
});

test("a dotted JSX element resolves through its import; hosts and closing tags add nothing", () => {
  const widgets = { "a/k.tsx": "export function Card() { return null; }\nexport function Row() { return null; }\n", "z/k.tsx": "export function Card() { return null; }\n", "b/i.ts": `export * as K from "../a/k";\n` };
  const page = (head: string, body: string) => ({ ...widgets, "c/p.tsx": `${head}\nexport function Page(props: any) { return ${body}; }\n` });
  assert.deepEqual(calls(page(`import * as K from "../a/k";`, "<K.Card />"), "c/p.tsx#Page"), ["a/k.tsx#Card"], "a namespace, self-closing");
  assert.deepEqual(calls(page(`import * as K from "../a/k";`, "<K.Card>x</K.Card>"), "c/p.tsx#Page"), ["a/k.tsx#Card"], "open and close make one edge");
  assert.deepEqual(calls(page(`import { K } from "../b/i";`, "<K.Row />"), "c/p.tsx#Page"), ["a/k.tsx#Row"], "through export * as");
  assert.deepEqual(calls(page(`import { Card } from "../a/k";`, "<Card />"), "c/p.tsx#Page"), ["a/k.tsx#Card"], "direct");
  assert.deepEqual(calls(page("", "<div />"), "c/p.tsx#Page"), [], "intrinsic");
  assert.deepEqual(calls(page("", "<K.Card />"), "c/p.tsx#Page"), [], "a dotted name no import binds");
  assert.deepEqual(calls(page(`import * as K from "pkg";`, "<K.Card />"), "c/p.tsx#Page"), [], "a namespace from outside");
});

test("only a binding position shadows an import", () => {
  const widgets = { "a/w.tsx": "export function Widget() { return null; }\n", "z/w.tsx": "export function Widget() { return null; }\n" };
  const page = (fn: string) => ({ ...widgets, "c/p.tsx": `import { Widget } from "../a/w";\nexport const Page = ${fn};\n` });
  const target = ["a/w.tsx#Widget"];
  assert.deepEqual(calls(page("({ x = Widget }) => <Widget />"), "c/p.tsx#Page"), target, "a destructuring default's value");
  assert.deepEqual(calls(page("(x = Widget) => <Widget />"), "c/p.tsx#Page"), target, "a parameter default's value");
  assert.deepEqual(calls(page("({ a: { b = Widget } }) => <Widget />"), "c/p.tsx#Page"), target, "a nested default's value");
  for (const shadow of ["({ Widget }) =>", "({ a: Widget }) =>", "([Widget]) =>", "(Widget = 1) =>", "(...Widget) =>", "({ Widget = 1 }) =>", "Widget =>"]) {
    assert.deepEqual(calls(page(`${shadow} <Widget />`), "c/p.tsx#Page"), [], shadow);
  }
});

test("a const that wraps a function is indexed as one; other consts are not", () => {
  const out = (text: string) => extractFile("c/x.tsx", text, "tsx").nodes.map((n) => `${n.id}:${n.kind}`).filter((n) => !n.startsWith("c/x.tsx:"));
  const ok = (name: string) => [`c/x.tsx#${name}:function`];
  assert.deepEqual(out(`export const A = React.forwardRef<H, P>((props, ref) => null);\n`), ok("A"));
  assert.deepEqual(out(`const A = forwardRef(function A(props, ref) { return null; });\n`), ok("A"));
  assert.deepEqual(out(`export const A = memo(forwardRef((props, ref) => null));\n`), ok("A"));
  assert.deepEqual(out(`export const A = React.memo(function Inner() { return null; });\n`), ok("A"));
  assert.deepEqual(out(`export const A = observer(() => null);\n`), ok("A"));
  assert.deepEqual(out(`export const A = 1;\nexport const B = make();\nexport const C = make(1, 2);\nexport const D = items.map((x) => x);\nexport const E = { f: () => 1 };\n`).filter((n) => !/#(E|f|E\.f)/.test(n)), []);
  // Calls inside the wrapped body belong to the const, and an import reaches it.
  const files = { "a/w.tsx": `import { forwardRef } from "react";\nfunction helper() {}\nexport const Card = forwardRef((p, r) => { helper(); return null; });\n`, "c/p.tsx": `import { Card } from "../a/w";\nexport function Page() { return <Card />; }\n` };
  assert.deepEqual(calls(files, "a/w.tsx#Card"), ["a/w.tsx#helper"]);
  assert.deepEqual(calls(files, "c/p.tsx#Page"), ["a/w.tsx#Card"]);
});

async function buildCalls(t: { after: (f: () => void) => void }, files: Record<string, string>, source: string): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), "ts-paths-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  await buildGraph(root);
  const graph = JSON.parse(readFileSync(join(root, "graft", ".graph", "wiring.json"), "utf8"));
  return graph.edges.filter((e: { relation: string; source: string }) => e.relation === "calls" && e.source === source).map((e: { target: string }) => e.target);
}

test("tsconfig paths arrive through extends and tsconfig.base.json", async (t) => {
  const code = {
    "libs/core/src/index.ts": "export function make() {}\n",
    "libs/other/src/index.ts": "export function make() {}\n",
    "apps/web/src/a.ts": `import { make } from "@acme/core";\nexport function run() { make(); }\n`,
  };
  const base = `{ "compilerOptions": { "paths": { "@acme/core": ["libs/core/src/index.ts"] } } }\n`;
  const want = ["libs/core/src/index.ts#make"];
  assert.deepEqual(await buildCalls(t, { ...code, "tsconfig.base.json": base }, "apps/web/src/a.ts#run"), want, "tsconfig.base.json alone");
  assert.deepEqual(await buildCalls(t, { ...code, "tsconfig.base.json": base, "apps/web/tsconfig.json": `{ "extends": "../../tsconfig.base.json" }\n` }, "apps/web/src/a.ts#run"), want, "extends");
  assert.deepEqual(await buildCalls(t, { ...code, "tsconfig.base.json": base, "apps/web/tsconfig.json": `{ "extends": ["../../tsconfig.base"] }\n` }, "apps/web/src/a.ts#run"), want, "an array, no extension");
  const cycle = { ...code, "apps/web/tsconfig.json": `{ "extends": "./b.json" }\n`, "apps/web/b.json": `{ "extends": "./tsconfig.json" }\n` };
  assert.deepEqual(await buildCalls(t, cycle, "apps/web/src/a.ts#run"), [], "a cycle ends, and maps nothing");
});

test("a workspace package's name reaches its source", async (t) => {
  const code = {
    "packages/core/package.json": `{ "name": "@acme/core" }\n`,
    "packages/core/src/index.ts": "export function make() {}\n",
    "packages/core/src/deep.ts": "export function dig() {}\n",
    "packages/other/src/index.ts": "export function make() {}\nexport function dig() {}\n",
    "apps/a.ts": `import { make } from "@acme/core";\nimport { dig } from "@acme/core/deep";\nexport function run() { make(); dig(); }\n`,
  };
  assert.deepEqual((await buildCalls(t, code, "apps/a.ts#run")).sort(), ["packages/core/src/deep.ts#dig", "packages/core/src/index.ts#make"]);
});
