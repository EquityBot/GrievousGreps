import { test } from "node:test";
import assert from "node:assert/strict";
import { warmDepthGrammars } from "../src/graph/depth-parser.js";
import { extractFile } from "../src/graph/extract.js";
import { resolveEdges } from "../src/graph/resolve.js";

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

test("no applicable import keeps today's name lookup", () => {
  const one = { "a/only.ts": "export function solo() {}\n" };
  assert.deepEqual(calls({ ...one, "c/use.ts": `export function run() { solo(); }\n` }, "c/use.ts#run"), ["a/only.ts#solo"], "no import");
  assert.deepEqual(calls({ ...one, "c/use.ts": `import { solo } from "@acme/alias";\nexport function run() { solo(); }\n` }, "c/use.ts#run"), ["a/only.ts#solo"], "an alias this cannot read");
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
