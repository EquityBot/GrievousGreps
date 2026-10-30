/**
 * The generic (breadth) tier: one language-agnostic extractor over a WASM grammar
 * + its tags.scm. These tests prove (a) it emits well-formed graft nodes/edges
 * for a language with NO hand-written extractor, and (b) the EXISTING resolver
 * resolves its bare-name call edges with zero language-specific code.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  warmGenericGrammars,
  extractGeneric,
  genericLangOf,
  isWarm,
  loadWasmLanguage,
  parseWasm,
  swapGrammarForTest,
  type TsNode,
} from "../src/graph/generic.js";
import { resolveEdges } from "../src/graph/resolve.js";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { checkGraph } from "../src/graph/check.js";
import { contextDirFor } from "../src/context/node-file.js";
import { skeleton } from "../src/ask/ask.js";

const RUST = `pub struct Config {
    name: String,
}

pub fn load() -> Config {
    let c = parse();
    Config { name: c }
}

fn parse() -> String {
    helper()
}

fn helper() -> String {
    String::new()
}
`;

test("genericLangOf routes .rs to the breadth tier (and not depth-tier extensions)", () => {
  assert.equal(genericLangOf("src/main.rs")?.name, "rust");
  assert.equal(genericLangOf("src/init.lua")?.name, "lua");
  assert.equal(genericLangOf("src/app.gleam")?.name, "gleam");
  assert.equal(genericLangOf("src/app.ts"), null); // depth tier owns .ts
  assert.equal(genericLangOf("README.md"), null);
});

test("Rust: a path call picks its type's associated function among same-named ones, and calls inside macros count", async () => {
  await warmGenericGrammars(["rust"]);
  const src = `struct Engine;
struct Store;
impl<'a> Engine<'a> {
    fn new() -> Self { Self::make() }
    fn make() -> Self { Engine }
}
impl Store {
    fn new() -> Self { Store }
}
fn evaluate() { let e = Engine::new(); let v = Vec::new(); }
fn other() { let s = crate::store::Store::new(); }
fn parse(x: &str) -> bool { true }
fn only_in_macro() {
    assert!(parse("a"));
    assert_eq!(Engine::make(), vec![one(two[0]), Store { x: 1 }]);
}
fn one(x: i32) {}
`;
  const { nodes, rawEdges } = extractGeneric("lib.rs", src, "rust");
  assert.equal(nodes.find((n) => n.id === "lib.rs#new")?.owner, "Engine");
  assert.equal(nodes.find((n) => n.id === "lib.rs#new~2")?.owner, "Store");
  const edges = resolveEdges(nodes, rawEdges).filter((e) => e.relation === "calls").map((e) => `${e.source} -> ${e.target}`);
  assert.ok(edges.includes("lib.rs#evaluate -> lib.rs#new"), edges.join("\n"));
  assert.ok(edges.includes("lib.rs#other -> lib.rs#new~2"), edges.join("\n"));
  assert.ok(edges.includes("lib.rs#new -> lib.rs#make"), "Self:: is the enclosing impl");
  assert.ok(edges.includes("lib.rs#only_in_macro -> lib.rs#parse"), "a call inside assert!");
  assert.ok(edges.includes("lib.rs#only_in_macro -> lib.rs#make"), "a path call inside a macro");
  assert.ok(edges.includes("lib.rs#only_in_macro -> lib.rs#one"), "a call inside a nested macro");
  assert.ok(!edges.some((e) => e.startsWith("lib.rs#evaluate ->") && e.endsWith("#new~2")), "Vec::new is not Store::new");
});

test("Rust: a macro body gives an edge only for a target its tokens decide", async () => {
  await warmGenericGrammars(["rust"]);
  const src = `struct Repo;
impl Repo {
    fn is_empty(&self) -> bool { true }
    fn size() -> usize { 0 }
    fn open() -> Repo { Repo }
}
fn not(x: bool) -> bool { x }
fn missing() {}
fn parse(x: &str) -> bool { true }
fn method_call(items: Vec<u8>) { assert!(items.is_empty()); }
fn predicate() { assert!(cfg!(not(feature = "x"))); }
fn direct_predicate() -> bool { cfg!(not(feature = "x")) }
fn other_type() { assert_eq!(Vec::new(), Other::missing()); }
fn bare_method_name() { assert_eq!(size(), 0); }
fn typed() { assert!(Repo::open().is_empty()); }
fn free() { assert!(parse("a")); assert!(rules::parse("b")); }
`;
  const { nodes, rawEdges } = extractGeneric("lib.rs", src, "rust");
  const edges = resolveEdges(nodes, rawEdges).filter((e) => e.relation === "calls").map((e) => `${e.source} -> ${e.target}`);
  for (const source of ["method_call", "predicate", "direct_predicate", "other_type", "bare_method_name"]) {
    assert.deepEqual(edges.filter((e) => e.startsWith(`lib.rs#${source} ->`)), [], source);
  }
  assert.deepEqual(edges.filter((e) => e.startsWith("lib.rs#typed ->")), ["lib.rs#typed -> lib.rs#open"]);
  assert.deepEqual(edges.filter((e) => e.startsWith("lib.rs#free ->")), ["lib.rs#free -> lib.rs#parse"]);
});

test("Rust: a bare call in a macro leaves its file only through a use", async () => {
  await warmGenericGrammars(["rust"]);
  const other = extractGeneric("b/src/other.rs", "pub fn measure() {}\n", "rust");
  const edge = (src: string) => {
    const here = extractGeneric("a/src/lib.rs", src, "rust");
    return resolveEdges([...here.nodes, ...other.nodes], [...here.rawEdges, ...other.rawEdges])
      .filter((e) => e.relation === "calls").map((e) => e.target);
  };
  assert.deepEqual(edge("fn t() { assert!(measure()); }\n"), [], "no route to it");
  assert.deepEqual(edge("use b::other::measure;\nfn t() { assert!(measure()); }\n"), ["b/src/other.rs#measure"], "a use");
  assert.deepEqual(edge("use b::other::*;\nfn t() { assert!(measure()); }\n"), ["b/src/other.rs#measure"], "a glob");
  assert.deepEqual(edge("use c::unrelated::*;\nfn t() { assert!(measure()); }\n"), [], "a glob of another module");
  assert.deepEqual(edge("mod tests {\n    use super::*;\n    fn t() { assert!(measure()); }\n}\n"), [], "a test module's glob of its own file");
  assert.deepEqual(edge("fn t() { assert!(other::measure()); }\n"), ["b/src/other.rs#measure"], "a path");
});

test("Rust: a path that starts in std or a dependency does not resolve to a repo type", async () => {
  await warmGenericGrammars(["rust"]);
  const lib = `pub struct Error;
impl Error { pub fn new() -> Error { Error } }
pub fn swap() {}
`;
  const other = extractGeneric("crates/a/src/lib.rs", lib, "rust");
  const edge = (body: string) => {
    const here = extractGeneric("crates/b/src/lib.rs", body, "rust");
    return resolveEdges([...other.nodes, ...here.nodes], [...other.rawEdges, ...here.rawEdges], { rustExternalCrates: new Set(["serde_json"]) })
      .filter((e) => e.relation === "calls" && e.source.startsWith("crates/b/")).map((e) => e.target);
  };
  const target = ["crates/a/src/lib.rs#new"];
  for (const body of [
    "use std::io;\nfn t() { io::Error::new(); }\n",
    "use std::io::Error;\nfn t() { Error::new(); }\n",
    "use std::{io, fmt};\nfn t() { io::Error::new(); }\n",
    "fn t() { std::io::Error::new(); }\n",
    "fn t() { serde_json::Error::new(); }\n",
    "use serde_json as sj;\nfn t() { sj::Error::new(); }\n",
    "use std::io;\nfn t() { assert!(io::Error::new()); }\n",
    "fn t() { std::mem::swap(); }\n",
    "fn t() { assert!(std::mem::swap()); }\n",
  ]) {
    assert.deepEqual(edge(body), [], body);
  }
  for (const body of [
    "fn t() { Error::new(); }\n",
    "fn t() { a::Error::new(); }\n",
    "use a::Error;\nfn t() { Error::new(); }\n",
    "fn t() { crate::Error::new(); }\n",
    "use a::Error;\nfn t() { assert!(Error::new()); }\n",
  ]) {
    assert.deepEqual(edge(body), target, body);
  }
});

test("Rust: Cargo.toml says which crates are outside the repo", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { buildGraph } = await import("../src/graph/build.js");
  const { readGraph, wiringPath } = await import("../src/graph/write.js");
  const root = mkdtempSync(join(tmpdir(), "rust-crates-"));
  const files: Record<string, string> = {
    "crates/a/Cargo.toml": '[package]\nname = "a-crate"\n',
    "crates/a/src/lib.rs": "pub struct Error;\nimpl Error { pub fn new() -> Error { Error } }\n",
    "crates/b/Cargo.toml": '[package]\nname = "b"\n[dependencies]\na-crate = { path = "../a" }\nserde-json = "1"\n[dependencies.anyhow]\nversion = "1"\n',
    "crates/b/src/lib.rs": "fn outside() { serde_json::Error::new(); anyhow::Error::new(); }\nfn inside() { a_crate::Error::new(); }\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  await buildGraph(root);
  const calls = readGraph(wiringPath(join(root, "graft")))!.edges.filter((e) => e.relation === "calls").map((e) => `${e.source} -> ${e.target}`);
  assert.deepEqual(calls, ["crates/b/src/lib.rs#inside -> crates/a/src/lib.rs#new"]);
});

test("Rust: a use reaches only the module that holds it, and each group item has its own crate", async () => {
  await warmGenericGrammars(["rust"]);
  const fsModule = extractGeneric("src/fs.rs", "pub fn copy() {}\n", "rust");
  const toFs = ["src/fs.rs#copy"];
  const edge = (body: string, source = "src/lib.rs#t") => {
    const here = extractGeneric("src/lib.rs", body, "rust");
    return resolveEdges([...fsModule.nodes, ...here.nodes], [...fsModule.rawEdges, ...here.rawEdges], { rustExternalCrates: new Set(["bstr"]) })
      .filter((e) => e.relation === "calls" && e.source === source).map((e) => e.target);
  };
  const tests = "#[cfg(test)]\nmod tests {\n    use std::fs;\n    fn u() { fs::copy(); }\n}\n";
  assert.deepEqual(edge(`mod fs;\nfn t() { fs::copy(); }\n${tests}`), toFs, "a test module's use stays there");
  assert.deepEqual(edge(`mod fs;\nfn t() {}\n${tests}`, "src/lib.rs#u"), [], "and holds inside it");
  assert.deepEqual(edge("use std::fs;\nfn t() { fs::copy(); }\n"), [], "a file-level use");
  assert.deepEqual(edge("fn t() { use std::fs; fs::copy(); }\n"), [], "a use in the function's block");
  assert.deepEqual(edge("fn other() { use std::fs; }\nfn t() { fs::copy(); }\n"), toFs, "a use in another function's block");
  assert.deepEqual(edge("use std::fs;\nmod m {\n    fn t() { fs::copy(); }\n}\n", "src/lib.rs#t"), toFs, "a nested mod does not inherit");
  assert.deepEqual(edge("use std::fs;\nmod m {\n    use super::*;\n    fn t() { fs::copy(); }\n}\n", "src/lib.rs#t"), [], "unless it globs super");
  assert.deepEqual(edge("use {bstr::ByteVec, crate::fs};\nfn t() { fs::copy(); }\n"), toFs, "a group's items keep their own crate");
  assert.deepEqual(edge("use {crate::x, bstr::fs};\nfn t() { fs::copy(); }\n"), [], "and the other way round");
  assert.deepEqual(edge("use std::{io, fs as files};\nfn t() { files::copy(); }\n"), [], "a rename inside a group");
  assert.deepEqual(edge("use std::fs::{self};\nfn t() { fs::copy(); }\n"), [], "self in a group binds its parent");
});

test("Rust: a call's syntax says what its target can be", async () => {
  await warmGenericGrammars(["rust"]);
  const edge = (body: string, source = "lib.rs#t") => {
    const here = extractGeneric("lib.rs", body, "rust");
    return resolveEdges(here.nodes, here.rawEdges).filter((e) => e.relation === "calls" && e.source === source).map((e) => e.target);
  };
  const freeWrite = "fn write() {}\n";
  assert.deepEqual(edge(`${freeWrite}fn t(f: F) { write!(f, "x"); }\n`), [], "a std macro is not the free function");
  assert.deepEqual(edge(`${freeWrite}fn t(f: F) { f.write(); }\n`), [], "a method call is not the free function");
  assert.deepEqual(edge(`${freeWrite}fn t() { write(); }\n`), ["lib.rs#write"], "a bare call is");
  assert.deepEqual(edge("macro_rules! tell { () => {} }\nfn t() { tell!(); }\n"), ["lib.rs#tell"], "a repo macro is a target");
  assert.deepEqual(edge("struct S;\nimpl S { fn write(&self) {} }\nfn t(s: S) { s.write(); }\n"), ["lib.rs#write"], "a method call can reach a method");
  assert.deepEqual(edge("struct S;\nimpl S { fn write(&self) {} }\nfn t() { write(); }\n"), [], "a bare call cannot");
  // A type path holds to that type.
  const section = "struct SectionNumber;\nimpl SectionNumber { fn new() {} }\n";
  for (const other of ["Vec::new();", "PathBuf::new();", "Other::new();", "T::new();"]) {
    assert.deepEqual(edge(`${section}fn t() { ${other} }\n`), [], other);
  }
  assert.deepEqual(edge(`${section}fn t() { SectionNumber::new(); }\n`), ["lib.rs#new"]);
});

test("Rust: a repo type with no single matching member is stated, not guessed", async () => {
  await warmGenericGrammars(["rust"]);
  const unresolved = (body: string) => {
    const here = extractGeneric("lib.rs", body, "rust");
    const out: { source: string; name: string; through: string | null }[] = [];
    const edges = resolveEdges(here.nodes, here.rawEdges, { unresolvedCalls: out }).filter((e) => e.relation === "calls" && e.source === "lib.rs#t");
    return { edges: edges.map((e) => e.target), out };
  };
  const line = "struct LineRange;\nimpl From<A> for LineRange { fn from(a: A) -> Self { LineRange } }\nimpl From<B> for LineRange { fn from(b: B) -> Self { LineRange } }\n";
  const missed = [{ source: "lib.rs#t", name: "from", through: "LineRange" }];
  assert.deepEqual(unresolved(`${line}fn t() { LineRange::from(a); }\n`), { edges: [], out: missed }, "several impls");
  const namesake = extractGeneric("other.rs", "pub struct Date;\nimpl Date { pub fn new() {} }\n", "rust");
  const here = extractGeneric("lib.rs", "struct Date;\nimpl Date { fn new() {} }\nfn t() { Date::new(); }\n", "rust");
  assert.deepEqual(
    resolveEdges([...namesake.nodes, ...here.nodes], [...namesake.rawEdges, ...here.rawEdges]).filter((e) => e.relation === "calls").map((e) => e.target),
    ["lib.rs#new"],
    "this file's type over another crate's namesake",
  );
  assert.deepEqual(unresolved("struct S;\nfn t() { S::missing(); }\n"), { edges: [], out: [{ source: "lib.rs#t", name: "missing", through: "S" }] }, "no such member");
  assert.deepEqual(unresolved("fn t() { Vec::new(); }\n"), { edges: [], out: [] }, "a type outside the repo says nothing");
});

test("Rust: a type alias or generic bound reaches the real owner", async () => {
  await warmGenericGrammars(["rust"]);
  const edge = (body: string) => {
    const here = extractGeneric("lib.rs", body, "rust");
    const out: { name: string; through: string | null }[] = [];
    const targets = resolveEdges(here.nodes, here.rawEdges, { unresolvedCalls: out as never })
      .filter((e) => e.relation === "calls" && /#(W\.)?t$/.test(e.source)).map((e) => e.target);
    return { targets, stated: out.map((c) => c.through) };
  };
  const engine = "struct Engine;\nimpl Engine { fn start() {} }\nstruct Other;\nimpl Other { fn start() {} }\n";
  const started = { targets: ["lib.rs#start"], stated: [] };
  assert.deepEqual(edge(`${engine}type Alias = Engine;\nfn t() { Alias::start(); }\n`), started, "a type alias");
  assert.deepEqual(edge(`${engine}type Alias = crate::x::Engine;\nfn t() { Alias::start(); }\n`), started, "a path alias");
  assert.deepEqual(edge(`${engine}use crate::Engine as E;\nfn t() { E::start(); }\n`), started, "a use rename");
  const job = "trait Job { fn go(); }\nstruct Nope;\nimpl Nope { fn go() {} }\n";
  const went = { targets: ["lib.rs#go"], stated: [] };
  assert.deepEqual(edge(`${job}fn t<T: Job>() { T::go(); }\n`), went, "a bound");
  assert.deepEqual(edge(`${job}fn t<T>() where T: Job { T::go(); }\n`), went, "a where clause");
  assert.deepEqual(edge(`${job}struct W<T>(T);\nimpl<T: Job> W<T> { fn t() { T::go(); } }\n`), went, "an impl's bound");
  assert.deepEqual(edge(`${job}fn t<T: Display>() { T::go(); }\n`), { targets: [], stated: [] }, "a bound from outside the repo");
});

test("Rust: an import from outside the repo binds its name", async () => {
  await warmGenericGrammars(["rust"]);
  const edge = (body: string, opts = {}) => {
    const files = [extractGeneric("src/lib.rs", body, "rust"), extractGeneric("src/other.rs", "pub fn f() {}\npub fn g() {}\npub struct S;\nimpl S { pub fn m() {} }\n", "rust")];
    return resolveEdges(files.flatMap((x) => x.nodes), files.flatMap((x) => x.rawEdges), opts)
      .filter((e) => e.relation === "calls" && e.source === "src/lib.rs#t").map((e) => e.target);
  };
  const outside = { rustExternalCrates: new Set(["dep"]) };
  assert.deepEqual(edge("use dep::f;\nfn t() { f(); }\n", outside), [], "a dependency's function");
  assert.deepEqual(edge("use dep::g as f;\nfn t() { f(); }\n", outside), [], "renamed");
  assert.deepEqual(edge("use std::cmp::min as f;\nfn t() { f(); }\n"), [], "std, renamed");
  assert.deepEqual(edge("use dep::S;\nfn t() { S::m(); }\n", outside), [], "a dependency's type");
  assert.deepEqual(edge("use crate::other::f;\nfn t() { f(); }\n", outside), ["src/other.rs#f"], "the repo's own");
});

test("Rust: a plainly std receiver does not bind a repo method of that name", async () => {
  await warmGenericGrammars(["rust"]);
  const lib = "pub trait P { fn map(self); fn rev(self); fn sum(self); }\n";
  const edge = (call: string) => {
    const here = extractGeneric("lib.rs", `${lib}fn t(v: X) { ${call}; }\n`, "rust");
    return resolveEdges(here.nodes, here.rawEdges, {}).filter((e) => e.relation === "calls" && e.source === "lib.rs#t").map((e) => e.target);
  };
  for (const call of ["v.iter().map(f)", "v.into_iter().map(f).sum()", "(0..3).rev()", "\"a\".chars().rev()", "Vec::new().iter().sum()", "Some(1).map(f)"]) {
    assert.deepEqual(edge(call).filter((t) => /#(map|rev|sum)$/.test(t) || /\.(map|rev|sum)$/.test(t)), [], call);
  }
  assert.equal(edge("v.par_iter().map(f)").length, 1, "rayon's own adaptor keeps its edge");
  assert.equal(edge("v.map(f)").length, 1, "an unknown receiver keeps its edge");
});

test("Rust: a type alias holds only where it is in scope", async () => {
  await warmGenericGrammars(["rust"]);
  const edge = (files: Record<string, string>, source: string) => {
    const x = Object.entries(files).map(([p, t]) => extractGeneric(p, t, "rust"));
    return resolveEdges(x.flatMap((f) => f.nodes), x.flatMap((f) => f.rawEdges), {}).filter((e) => e.relation === "calls" && e.source === source).map((e) => e.target);
  };
  const types = "pub struct One;\nimpl One { pub fn go() {} }\npub struct Two;\nimpl Two { pub fn go() {} }\n";
  const two = { "src/t.rs": types, "src/a.rs": "type Alias = One;\nfn a() { Alias::go(); }\n", "src/b.rs": "type Alias = Two;\nfn b() { Alias::go(); }\n" };
  const go = (type: string) => edge(two, type === "One" ? "src/a.rs#a" : "src/b.rs#b");
  assert.equal(go("One").length, 1);
  assert.equal(go("Two").length, 1);
  assert.notDeepEqual(go("One"), go("Two"), "each file's alias reads its own type");
  // Another module's alias lends a real type of the same name nothing.
  const real = { "src/t.rs": "pub struct One;\nimpl One { pub fn only() {} }\n", "src/a.rs": "type Named = One;\n", "src/n.rs": "pub struct Named;\nimpl Named { pub fn own() {} }\nfn c() { Named::only(); }\n" };
  assert.deepEqual(edge(real, "src/n.rs#c"), [], "a real type does not inherit a namesake alias");
});

test("extractGeneric emits nodes + bare-name call edges for Rust (no rust-specific code)", async () => {
  await warmGenericGrammars(["rust"]);
  assert.ok(isWarm("rust"), "rust grammar should warm");
  const { nodes, rawEdges } = extractGeneric("lib.rs", RUST, "rust");

  const kinds = nodes.filter((n) => n.kind !== "file").map((n) => `${n.kind}:${n.name}`).sort();
  assert.deepEqual(kinds, ["function:helper", "function:load", "function:parse", "struct:Config"]);

  // every non-file node carries the generic provenance + a span + a signature
  for (const n of nodes.filter((n) => n.kind !== "file")) {
    assert.equal(n.origin, "generic");
    assert.match(n.span, /^L\d+-L\d+$/);
    assert.ok(n.signature && n.signature.length > 0, `${n.name} has a signature`);
  }

  // calls are bare-name raw edges attributed to their enclosing function
  const calls = rawEdges.filter((e) => e.relation === "calls");
  const pairs = calls.map((e) => `${e.source.split("#")[1]}→${e.name}`).sort();
  assert.ok(pairs.includes("load→parse"), `load calls parse (got ${pairs.join(", ")})`);
  assert.ok(pairs.includes("parse→helper"), "parse calls helper");
});

test("the EXISTING resolver resolves generic-tier Rust calls by name", async () => {
  await warmGenericGrammars(["rust"]);
  const { nodes, rawEdges } = extractGeneric("lib.rs", RUST, "rust");
  const edges = resolveEdges(nodes, rawEdges);
  const call = edges.find((e) => e.relation === "calls" && e.source.endsWith("#load"));
  assert.ok(call, "load's call edge survived resolution");
  assert.equal(call?.target, "lib.rs#parse", "resolved to the same-file parse definition");
  assert.equal(call?.confidence, "extracted", "same-file → extracted");
});

// One inline snippet per breadth language, each exercising a definition + a call
// that must resolve. Java/Ruby/C# calls target METHODS — proving the generic-origin
// call-kind widening (resolve.ts) works, not just function-target languages.
const SNIPPETS: Array<{ lang: string; file: string; src: string; defs: string[]; call: [string, string] }> = [
  {
    lang: "java", file: "A.java",
    src: `class A {\n  int run() { return helper(); }\n  int helper() { return 1; }\n}\n`,
    defs: ["class:A", "method:helper", "method:run"], call: ["run", "helper"],
  },
  {
    // Explicit call (`self.draw`), not a parenless bareword: graft's ruby query
    // captures only real call nodes — the upstream bareword @reference.call
    // needs locals-tracking graft doesn't run, so it's dropped for precision.
    lang: "ruby", file: "a.rb",
    src: `class Widget\n  def render\n    self.draw\n  end\n  def draw\n    1\n  end\nend\n`,
    defs: ["class:Widget", "method:draw", "method:render"], call: ["render", "draw"],
  },
  {
    lang: "c_sharp", file: "A.cs",
    src: `class A {\n  int Run() { return Helper(); }\n  int Helper() { return 1; }\n}\n`,
    defs: ["class:A", "method:Helper", "method:Run"], call: ["Run", "Helper"],
  },
  {
    lang: "c", file: "a.c",
    src: `int helper() { return 1; }\nint run() { return helper(); }\n`,
    defs: ["function:helper", "function:run"], call: ["run", "helper"],
  },
  {
    // Lisp: every form is a bare list_lit, so definitions are matched by the
    // head symbol's name (`defn`, `ns`, …), not a dedicated grammar node.
    lang: "clojure", file: "a.clj",
    src: `(ns my.core)\n\n(defn helper [] 1)\n\n(defn run [] (helper))\n`,
    defs: ["function:helper", "function:run", "module:my.core"], call: ["run", "helper"],
  },
  {
    // Lua functions can be declarations, assigned expressions, or table fields;
    // colon syntax defines and calls methods.
    lang: "lua", file: "a.lua",
    src: `local function helper()\n  return 1\nend\n\nlocal assigned = function()\n  return helper()\nend\n\nlocal handlers = { draw = function() return helper() end }\n\nfunction Widget:run()\n  return helper()\nend\n\nlocal function launch()\n  return Widget:run()\nend\n`,
    defs: ["function:assigned", "function:draw", "function:helper", "function:launch", "method:run"], call: ["launch", "run"],
  },
  {
    // Nix: a binding whose value is a lambda (let-bound or attrset field) becomes
    // a function def; a non-function binding (`version`) is not emitted, and an
    // application of one binding by another resolves as a call.
    lang: "nix", file: "a.nix",
    src: `let\n  helper = x: x + 1;\nin {\n  greet = name: helper 2;\n  version = "1.0";\n}\n`,
    defs: ["function:greet", "function:helper"], call: ["greet", "helper"],
  },
  {
    // Gleam's module functions are declarations, while custom types are named
    // through their nested `type_name` node. Constants and the variants of a
    // custom type are API too — `Ready` is a callable you can pass around. A
    // direct function call still resolves through the bare-name resolver.
    lang: "gleam", file: "src/app.gleam",
    src: `pub const limit = 3

pub type State { Ready }

pub fn helper() { 1 }

pub fn run() { helper() }
`,
    defs: ["constant:limit", "function:Ready", "function:helper", "function:run", "type:State"],
    call: ["run", "helper"],
  },
];

for (const s of SNIPPETS) {
  test(`breadth tier: ${s.lang} — defs + a call that the resolver resolves`, async () => {
    await warmGenericGrammars([s.lang]);
    assert.ok(isWarm(s.lang), `${s.lang} grammar warms`);
    const { nodes, rawEdges } = extractGeneric(s.file, s.src, s.lang);
    const kinds = nodes.filter((n) => n.kind !== "file").map((n) => `${n.kind}:${n.name}`).sort();
    assert.deepEqual(kinds, s.defs, `${s.lang} definitions`);
    const edges = resolveEdges(nodes, rawEdges);
    const call = edges.find((e) => e.relation === "calls" && e.source.endsWith(`#${s.call[0]}`));
    assert.ok(call, `${s.lang}: ${s.call[0]}'s call edge exists and is attributed to the caller`);
    assert.equal(call?.target, `${s.file}#${s.call[1]}`, `${s.lang}: resolved ${s.call[0]}→${s.call[1]}`);
  });
}

test("Gleam files build into a queryable wiring graph", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-gleam-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "src", "app.gleam"),
      `pub type State { Ready }

pub fn helper() { 1 }

pub fn run() { helper() }
`,
    );

    const built = await buildGraph(dir, { reuse: false });
    assert.deepEqual(built.languages, ["gleam"]);

    const graph = readGraph(wiringPath(built.contextDir));
    assert.ok(graph?.nodes.some((n) => n.id === "src/app.gleam#State"));
    assert.ok(graph?.edges.some((e) => e.source === "src/app.gleam#run" && e.target === "src/app.gleam#helper"));

    const api = skeleton(dir, "src/app.gleam");
    assert.deepEqual(api.entries.map((e) => e.name).sort(), ["Ready", "State", "helper", "run"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A two-module Gleam package: `app.gleam` reaches `app/thing.gleam` every way
 * Gleam offers, and reaches the stdlib the same way it reaches in-repo code. */
function gleamPackage(dir: string): void {
  mkdirSync(join(dir, "src", "app"), { recursive: true });
  // A local function whose name collides with gleam/list's — the bait for a
  // bare-name resolver. `Cfg` is the idiomatic type/constructor name collision.
  writeFileSync(join(dir, "src", "mine.gleam"), `pub fn map(x: Int) -> Int { x }\n`);
  writeFileSync(
    join(dir, "src", "app", "thing.gleam"),
    `pub type State {
  Ready
  Busy(since: Int)
}

pub type Cfg { Cfg(a: Int) }

pub fn helper(n: Int) -> Int { n }
`,
  );
  writeFileSync(
    join(dir, "src", "app.gleam"),
    `import gleam/list
import app/thing
import app/thing.{helper} as t

pub fn run(xs: List(Int), c: thing.Cfg) -> thing.State {
  list.map(xs, fn(x) { x })
  thing.helper(1)
  helper(2)
  let s = thing.Busy(since: 1)
  let _ = thing.Cfg(a: 2)
  case s { thing.Ready -> s _ -> s }
}
`,
  );
}

test("Gleam imports resolve to in-repo modules and leave the stdlib a string", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-gleam-imports-"));
  try {
    gleamPackage(dir);
    const built = await buildGraph(dir, { reuse: false });
    const g = readGraph(wiringPath(built.contextDir));
    const imports = (g?.edges ?? []).filter((e) => e.relation === "imports" && e.source === "src/app.gleam");
    assert.deepEqual([...new Set(imports.map((e) => e.target))].sort(), ["gleam/list", "src/app/thing.gleam"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Gleam qualified call resolves through the import, never by bare name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-gleam-calls-"));
  try {
    gleamPackage(dir);
    const built = await buildGraph(dir, { reuse: false });
    const g = readGraph(wiringPath(built.contextDir));
    const from = (g?.edges ?? []).filter((e) => e.source === "src/app.gleam#run");

    // `list.map` is gleam/list's — NOT the same-named function next door. This is
    // the whole point of routing qualified calls through the import table.
    assert.equal(from.find((e) => e.target === "src/mine.gleam#map"), undefined);

    // Both the qualified `thing.helper(1)` and the unqualified-import `helper(2)`
    // name the same module, so both land on that module's definition.
    assert.ok(from.some((e) => e.relation === "calls" && e.target === "src/app/thing.gleam#helper"));

    // Construction and destructuring reach a remote constructor.
    assert.ok(from.some((e) => e.relation === "calls" && e.target === "src/app/thing.gleam#Busy"));
    assert.ok(from.some((e) => e.relation === "calls" && e.target === "src/app/thing.gleam#Ready"));

    // A type and its constructor share the name `Cfg`; the use site picks which.
    const cfg = g?.nodes.find((n) => n.name === "Cfg" && n.kind === "type");
    const ctor = g?.nodes.find((n) => n.name === "Cfg" && n.kind === "function");
    assert.ok(cfg && ctor && cfg.id !== ctor.id, "both a Cfg type and a Cfg constructor exist");
    assert.ok(from.some((e) => e.relation === "references" && e.target === cfg.id), "`c: thing.Cfg` → the type");
    assert.ok(from.some((e) => e.relation === "calls" && e.target === ctor.id), "`thing.Cfg(a: 2)` → the constructor");

    // A type used only in an annotation is not an orphan.
    assert.ok(from.some((e) => e.relation === "references" && e.target === "src/app/thing.gleam#State"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Gleam call with no import to back it is dropped, not guessed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-gleam-drop-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "util.gleam"), `pub fn run(x: Int) -> Int { x }\n`);
    // `cfg.run()` is a record field holding a function — `cfg` is a local, not a
    // module, so there is nothing to scope the name to and no edge to be had.
    writeFileSync(
      join(dir, "src", "app.gleam"),
      `pub fn go(cfg) {\n  cfg.run(1)\n}\n`,
    );
    const built = await buildGraph(dir, { reuse: false });
    const g = readGraph(wiringPath(built.contextDir));
    assert.equal((g?.edges ?? []).find((e) => e.source === "src/app.gleam#go"), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Gleam function that is piped into or passed as a value is not an orphan", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-gleam-values-"));
  try {
    mkdirSync(join(dir, "src", "app"), { recursive: true });
    writeFileSync(
      join(dir, "src", "app", "thing.gleam"),
      `pub const limit = 3

pub fn piped(n: Int) -> Int { n }

pub fn handed(n: Int) -> Int { n }

pub fn name(n: Int) -> Int { n }
`,
    );
    writeFileSync(
      join(dir, "src", "app.gleam"),
      `import gleam/list
import app/thing

pub fn local(n: Int) -> Int { n }

pub fn run(xs: List(Int), cb) {
  let n = 1 |> thing.piped |> local |> cb
  list.map(xs, thing.handed)
  list.map(xs, local)
  list.map(xs, cb)
  n + thing.limit
}

pub fn show(thing) { thing.name }

pub fn apply(thing) { thing.piped(thing) }

pub type Shape { Shape(local: Int) }

pub fn unwrap(s: Shape) {
  let Shape(local:) = s
  list.map([1], fn(_) { local })
  [local]
}
`,
    );
    const built = await buildGraph(dir, { reuse: false });
    const g = readGraph(wiringPath(built.contextDir));
    const from = (id: string) => (g?.edges ?? []).filter((e) => e.source === id).map((e) => `${e.relation} ${e.target}`);
    const run = from("src/app.gleam#run");

    // The right of a pipe is applied, parentheses or not.
    assert.ok(run.includes("calls src/app/thing.gleam#piped"));
    assert.ok(run.includes("calls src/app.gleam#local"));

    // A callback is named, not called — and so is a constant.
    assert.ok(run.includes("references src/app/thing.gleam#handed"));
    assert.ok(run.includes("references src/app.gleam#local"));
    assert.ok(run.includes("references src/app/thing.gleam#limit"));

    // `cb` is a parameter: nothing to point at, piped or passed.
    assert.equal(run.find((e) => e.endsWith("#cb") || e.endsWith(" cb")), undefined);

    // In `show` and `apply`, `thing` is a parameter that shadows the import. Read
    // as a value, `thing.name` is a record field — not app/thing's `name`. Applied,
    // `thing.piped(thing)` is the module's function, which is what Gleam falls
    // back to when the record has no such field.
    assert.deepEqual(from("src/app.gleam#show"), []);
    assert.deepEqual(from("src/app.gleam#apply"), ["calls src/app/thing.gleam#piped"]);

    // `Shape(local:)` binds `local` by label shorthand, so `[local]` is that
    // value — not this file's `local` function.
    assert.equal(from("src/app.gleam#unwrap").find((e) => e.endsWith("#local")), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a bare Gleam name never resolves outside its own file and imports", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-gleam-bare-"));
  try {
    mkdirSync(join(dir, "src"), { recursive: true });
    // The only `commands` function and `State` type in the repo — exactly what a
    // repo-wide bare-name lookup would settle on.
    writeFileSync(join(dir, "src", "other.gleam"), `pub type State { State }\n\npub fn commands(x) { x }\n`);
    // Here `commands` is a parameter being called and `State` is not imported.
    writeFileSync(
      join(dir, "src", "app.gleam"),
      `pub fn local(x) { x }\n\npub fn run(commands, s: State) {\n  commands(1)\n  local(s)\n}\n`,
    );
    const built = await buildGraph(dir, { reuse: false });
    const g = readGraph(wiringPath(built.contextDir));
    const from = (g?.edges ?? []).filter((e) => e.source === "src/app.gleam#run").map((e) => `${e.relation} ${e.target}`);
    assert.deepEqual(from, ["calls src/app.gleam#local"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a Gleam file's own names resolve even when a nested package repeats its path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-gleam-nested-"));
  try {
    const src = `pub fn helper() { 1 }\n\npub fn run() { helper() }\n`;
    for (const root of [dir, join(dir, "packages", "inner")]) {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src", "app.gleam"), src);
    }
    const built = await buildGraph(dir, { reuse: false });
    const g = readGraph(wiringPath(built.contextDir));
    const calls = (g?.edges ?? []).filter((e) => e.relation === "calls").map((e) => `${e.source} -> ${e.target}`).sort();
    assert.deepEqual(calls, [
      "packages/inner/src/app.gleam#run -> packages/inner/src/app.gleam#helper",
      "src/app.gleam#run -> src/app.gleam#helper",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Gleam's newer syntax (echo, assert messages) parses without losing the surrounding calls", async () => {
  await warmGenericGrammars(["gleam"]);
  const src = `import app/thing

pub fn run(x) {
  let assert Ok(y) = thing.helper(x) as "must work"
  echo y
  echo y as "label"
  y
}
`;
  const { nodes, rawEdges } = extractGeneric("src/app.gleam", src, "gleam");
  assert.ok(nodes.some((n) => n.kind === "function" && n.name === "run"));
  assert.ok(
    rawEdges.some((e) => e.source === "src/app.gleam#run" && e.name === "helper" && e.specifier === "app/thing"),
    "the qualified call survives an `as` message and `echo` lines after it",
  );
});

// Structural references the grammar already marks — a supertype (extends), an
// implemented interface, an object creation — become `references` edges the resolver
// settles to a type-like definition. This is the breadth-tier orphan-rate fix: a class
// that is only ever extended or instantiated (never "called") stops being disconnected.
test("breadth tier: Java extends/implements/new become resolved references edges (precision-safe)", async () => {
  await warmGenericGrammars(["java"]);
  const src =
    `interface Animal {}\n` +
    `class Base {}\n` +
    `class Dog extends Base implements Animal {\n` +
    `  Base make() { return new Base(); }\n` +
    `}\n` +
    `class Cat extends UnknownExternal {}\n`; // external supertype → must be dropped, never guessed
  const { nodes, rawEdges } = extractGeneric("A.java", src, "java");
  const edges = resolveEdges(nodes, rawEdges);
  const refs = edges.filter((e) => e.relation === "references");
  const pairs = refs.map((e) => `${e.source.split("#")[1]}→${e.target.split("#")[1] ?? e.target}`);

  // extends + implements are attributed to the declaring class; `new Base()` to the method
  assert.ok(pairs.includes("Dog→Base"), `Dog extends Base (got ${pairs.join(", ")})`);
  assert.ok(pairs.includes("Dog→Animal"), "Dog implements Animal");
  assert.ok(pairs.includes("make→Base"), "make() references Base via `new Base()`");
  // same-file targets resolve as certain
  assert.ok(refs.every((e) => e.confidence === "extracted"), "same-file references are extracted");
  // an external/undefined supertype is dropped, not emitted as a bogus edge
  assert.ok(!refs.some((e) => e.target.includes("UnknownExternal")), "unresolved external type is dropped");
  // no self-loops (a class referencing its own name never becomes X→X)
  assert.ok(!refs.some((e) => e.source === e.target), "no self-loop references");
});

// C/C++ #include is the dependency graph the tags.scm can't see (it's the
// preprocessor). A local `#include "x.h"` becomes a file→file import the resolver
// settles to an in-repo header — relative first, then a unique path-suffix (an
// -I-reached header), and never a guess. System `<...>` includes are skipped.
test("breadth tier: C #include becomes a resolved file→file import (local only, drop-rather-than-guess)", async () => {
  await warmGenericGrammars(["c"]);
  const files: Record<string, string> = {
    "src/app.c": '#include "app.h"\n#include "net/sock.h"\n#include <stdio.h>\nint run(void){return 0;}\n',
    "src/app.h": "int run(void);\n",
    "src/net/sock.h": "int connect_sock(void);\n",
    "include/uniq.h": "int uq(void);\n", // reachable only via -I, unique basename
    "src/uses.c": '#include "uniq.h"\n',
    "a/util.h": "int a_u(void);\n", // two util.h → an ambiguous basename
    "b/util.h": "int b_u(void);\n",
    "src/amb.c": '#include "util.h"\n',
  };
  const nodes = [], raw = [];
  for (const [rel, src] of Object.entries(files)) {
    const r = extractGeneric(rel, src, "c");
    nodes.push(...r.nodes); raw.push(...r.rawEdges);
  }
  const imports = resolveEdges(nodes, raw).filter((e) => e.relation === "imports");
  const targetsOf = (src: string) => imports.filter((e) => e.source === src).map((e) => e.target);

  // relative include → the in-repo header (exact; same dir and a subdir)
  assert.ok(targetsOf("src/app.c").includes("src/app.h"), "app.c → app.h (same dir)");
  assert.ok(targetsOf("src/app.c").includes("src/net/sock.h"), "app.c → net/sock.h (subdir)");
  // system <stdio.h> is skipped entirely — no import edge minted
  assert.ok(!imports.some((e) => String(e.target).includes("stdio")), "system include is not captured");
  // a unique basename reached via -I resolves by suffix
  assert.ok(targetsOf("src/uses.c").includes("include/uniq.h"), "unique -I header resolves by suffix");
  // an ambiguous basename is NOT guessed — kept as the raw string, resolving to neither file
  assert.deepEqual(targetsOf("src/amb.c"), ["util.h"], "ambiguous include kept external, never guessed");
});

// Rust `use crate::…` → a file→module import, resolved against the file's crate root
// (the lib.rs/main.rs dir). The longest-prefix rule disambiguates a module from an item
// and a `foo.rs` from a `foo/mod.rs`; std/super/external/glob are skipped, and an
// unresolvable in-crate path is kept as a `crate::…` string, never guessed.
test("breadth tier: Rust use crate::… resolves to the in-repo module (longest-prefix, drop-rather-than-guess)", async () => {
  await warmGenericGrammars(["rust"]);
  const files: Record<string, string> = {
    "src/lib.rs": "pub mod error;\npub mod net;\n",
    "src/error.rs": "pub struct Error;\n",
    "src/net/mod.rs": "pub mod tcp;\n",
    "src/net/tcp.rs": "pub struct Stream;\n",
    "src/app.rs":
      "use crate::error::Error;\n" +          // item under a module → src/error.rs
      "use crate::net::tcp::Stream;\n" +       // nested module → src/net/tcp.rs
      "use crate::net;\n" +                    // single-segment module → src/net/mod.rs
      "use crate::missing::Thing;\n" +         // in-crate but no such file → kept as string
      "use std::io::Read;\n" +                 // external — skipped
      "use super::sibling::Thing;\n" +         // relative — skipped
      "use serde::Serialize;\n" +              // external crate — skipped
      "fn go() {}\n",
    // an integration test lives OUTSIDE the crate root (src/); its `crate::` is the test
    // binary's own root, not the lib — so it must NOT resolve across to src/error.rs.
    "tests/it.rs": "use crate::error::Error;\nfn t() {}\n",
  };
  const nodes = [], raw = [];
  for (const [rel, src] of Object.entries(files)) {
    const r = extractGeneric(rel, src, "rust");
    nodes.push(...r.nodes); raw.push(...r.rawEdges);
  }
  const imports = resolveEdges(nodes, raw).filter((e) => e.relation === "imports" && e.source === "src/app.rs");
  const targets = imports.map((e) => e.target).sort();

  assert.ok(targets.includes("src/error.rs"), "crate::error::Error → error.rs");
  assert.ok(targets.includes("src/net/tcp.rs"), "crate::net::tcp::Stream → net/tcp.rs");
  assert.ok(targets.includes("src/net/mod.rs"), "crate::net (single-segment module) → net/mod.rs");
  // in-crate but unresolvable → the full path kept as a string, never a guessed file edge
  // (crucially NOT silently resolved to the crate-root lib.rs)
  assert.ok(targets.includes("crate::missing::Thing"), "unresolved in-crate path kept as a string");
  // std / super / external crate are not in-crate imports — no edge at all
  assert.ok(!targets.some((t) => /io|sibling|serde|Read|Serialize/.test(t)), "external/relative use skipped");
  assert.equal(imports.length, 4, "exactly the 4 crate:: uses became edges");

  // an integration test's `crate::error::Error` must NOT cross into src/error.rs — its
  // crate root is unknown (it's the test binary), so it stays a string, never a false edge
  const fromTest = resolveEdges(nodes, raw).filter((e) => e.relation === "imports" && e.source === "tests/it.rs");
  assert.deepEqual(fromTest.map((e) => e.target), ["crate::error::Error"], "test-binary crate:: never resolves into the lib");
});

test("buildGraph + checkGraph handle a breadth-tier (.rs) repo end-to-end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-rust-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "lib.rs"), RUST);

  await buildGraph(dir, { reuse: false });
  const g = readGraph(wiringPath(contextDirFor(dir)));
  assert.ok(g, "graph built");
  const rust = g!.nodes.filter((n) => n.path.endsWith(".rs") && n.kind !== "file");
  assert.ok(rust.length >= 4, `indexed the rust defs (got ${rust.length})`);
  assert.ok(rust.every((n) => n.origin === "generic"), "rust nodes are generic-tier");
  assert.ok(g!.edges.some((e) => e.relation === "calls"), "rust call edges resolved");

  // check must agree with build — the async warmup means .rs files are re-extracted
  // identically, so a fresh graph reads as in-sync, not perpetually stale.
  const chk = await checkGraph(dir);
  assert.equal(chk.ok, true, `check OK on a breadth-tier repo (added=${chk.added}, removed=${chk.removed})`);
});

// #134: Dart is a breadth-tier language with no vendored tags.scm, so the
// node-kind walker minted class_body / locals and skipped top-level functions.
// Issue fixture — top-level const + functions + a method that calls a top-level fn.
const DART = `const int kThreshold = 3;

bool isReady(int count) => count >= kThreshold;

String describe(int count) {
  final label = isReady(count) ? 'ready' : 'waiting';
  return label;
}

class Counter {
  int value = 0;

  bool ready() => isReady(value);
}
`;

test("genericLangOf routes .dart to the breadth tier", () => {
  assert.equal(genericLangOf("lib/example.dart")?.name, "dart");
});

test("Dart top-level functions/consts become symbols; call edges resolve; body locals stay out (#134)", async () => {
  await warmGenericGrammars(["dart"]);
  assert.ok(isWarm("dart"), "dart grammar should warm");
  const { nodes, rawEdges } = extractGeneric("lib/example.dart", DART, "dart");
  const symbols = nodes.filter((n) => n.kind !== "file");
  const byName = new Map(symbols.map((n) => [n.name, n]));

  assert.equal(byName.get("isReady")?.kind, "function", "isReady is a top-level function");
  assert.equal(byName.get("describe")?.kind, "function", "describe is a top-level function");
  assert.equal(byName.get("kThreshold")?.kind, "constant", "kThreshold is a top-level const");
  assert.equal(byName.get("Counter")?.kind, "class");
  assert.equal(byName.get("ready")?.kind, "method", "Counter.ready is a method");

  assert.ok(!symbols.some((n) => n.name === "label"), "function-body local `label` is not a symbol");
  assert.ok(
    !symbols.some((n) => n.kind === "class" && n.name === "int"),
    `no bogus class int (got ${symbols.filter((n) => n.kind === "class").map((n) => n.name).join(", ")})`,
  );

  const edges = resolveEdges(nodes, rawEdges);
  const calls = edges
    .filter((e) => e.relation === "calls")
    .map((e) => `${e.source.split("#")[1]}→${e.target.split("#")[1]}`);
  assert.ok(calls.includes("describe→isReady"), `describe → isReady (got ${calls.join(", ")})`);
  assert.ok(calls.includes("ready→isReady"), `Counter.ready → isReady (got ${calls.join(", ")})`);
});

test("Dart file-level skeleton lists the API, not function-body locals (#134)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-dart-"));
  mkdirSync(join(dir, "lib"));
  writeFileSync(join(dir, "lib", "example.dart"), DART);

  await buildGraph(dir, { reuse: false });
  const r = skeleton(dir, "lib/example.dart");
  const names = r.entries.map((e) => e.name);
  for (const want of ["isReady", "describe", "kThreshold", "Counter", "ready"]) {
    assert.ok(names.includes(want), `skeleton includes ${want} (got ${names.join(", ")})`);
  }
  assert.ok(!names.includes("label"), "skeleton omits function-body local `label`");
  assert.ok(
    !r.entries.some((e) => e.kind === "class" && e.name === "int"),
    "skeleton has no bogus class int",
  );
});

// #139: tree-sitter-wasm 1.1.4's PHP grammar throws `memory access out of bounds`
// on heredoc/nowdoc, and extractGeneric swallows that into a file-only result.
// PHP is depth-tier now (.php is not claimed by the breadth registry), so this
// loads the wasm grammar directly — the same parse the breadth path used when
// the issue landed.
// v1.1.6 is the first release that parses these without crashing.
const PHP_HEREDOC = `<?php
namespace App;
class WithHeredoc {
    public function sql(): string {
        return <<<SQL
            SELECT 1
            SQL;
    }
    public function other(): int { return 2; }
}
`;

const PHP_NOWDOC = `<?php
namespace App;
class WithNowdoc {
    public function sql(): string {
        return <<<'SQL'
            SELECT 1
            SQL;
    }
    public function other(): int { return 2; }
}
`;

function namedOfType(root: TsNode, type: string): string[] {
  const names: string[] = [];
  const visit = (n: TsNode): void => {
    if (n.type === type) {
      const name = n.childForFieldName?.("name")?.text;
      if (name) names.push(name);
    }
    for (let i = 0; i < (n.namedChildCount ?? 0); i++) {
      const c = n.namedChild?.(i);
      if (c) visit(c);
    }
  };
  visit(root);
  return names;
}

async function assertPhpWasmExtractsClassAndMethods(source: string, className: string, label: string): Promise<void> {
  const language = await loadWasmLanguage("php");
  assert.ok(language, "tree-sitter-wasm must ship a php grammar");
  const root = parseWasm(language, source);
  assert.ok(root, `${label}: PHP wasm parse must not crash (1.1.4 threw on heredoc/nowdoc)`);
  const classes = namedOfType(root, "class_declaration");
  const methods = namedOfType(root, "method_declaration");
  assert.ok(classes.includes(className), `${label}: expected class ${className}, got: ${classes.join(", ") || "(none)"}`);
  assert.ok(methods.includes("sql"), `${label}: expected method sql, got: ${methods.join(", ") || "(none)"}`);
  assert.ok(methods.includes("other"), `${label}: expected method other, got: ${methods.join(", ") || "(none)"}`);
}

test("PHP wasm grammar extracts class + methods from a heredoc file (#139)", async () => {
  await assertPhpWasmExtractsClassAndMethods(PHP_HEREDOC, "WithHeredoc", "heredoc");
});

test("PHP wasm grammar extracts class + methods from a nowdoc file (#139)", async () => {
  await assertPhpWasmExtractsClassAndMethods(PHP_NOWDOC, "WithNowdoc", "nowdoc");
});

/**
 * A grammar whose parse throws (the tree-sitter-wasm PHP grammar did, on
 * heredocs — #139) must surface as a per-file build error, not be swallowed
 * into a silently symbol-less file that the extract cache then replays as a
 * clean parse. The real crash is heap-state dependent, so a deterministically
 * throwing fake grammar is swapped in via the test seam instead.
 */
const THROWING_GRAMMAR = {
  // web-tree-sitter's setLanguage() inspects the language object, so any
  // property access blowing up makes extractGeneric's try block throw exactly
  // like a crashing wasm scanner does.
  language: new Proxy({}, { get(): never { throw new Error("memory access out of bounds (fake)"); } }),
  query: null,
};

test("extractGeneric rethrows a throwing grammar with the language named (#139)", async () => {
  await warmGenericGrammars(["rust"]); // initialises web-tree-sitter
  const prev = swapGrammarForTest("rust", THROWING_GRAMMAR);
  try {
    assert.throws(
      () => extractGeneric("src/lib.rs", "pub fn f() {}\n", "rust"),
      (err: unknown): boolean => {
        assert.ok(err instanceof Error, "throws an Error");
        assert.match(err.message, /^rust grammar threw: /, "names the language");
        assert.match(err.message, /memory access out of bounds/, "keeps the original message");
        return true;
      },
    );
  } finally {
    swapGrammarForTest("rust", prev);
  }
});

test("a throwing grammar is a per-file build error, cached as a failure (#139)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-throwing-grammar-"));
  writeFileSync(join(dir, "lib.rs"), "pub fn f() {}\n");
  await warmGenericGrammars(["rust"]); // so buildGraph's own warm call is a no-op
  const prev = swapGrammarForTest("rust", THROWING_GRAMMAR);
  try {
    const first = await buildGraph(dir, { reuse: false });
    assert.equal(first.errors.length, 1, `one build error (got: ${first.errors.join("; ")})`);
    assert.match(first.errors[0], /lib\.rs: parse failed/);
    assert.match(first.errors[0], /rust grammar threw: memory access out of bounds/);
    const g = readGraph(wiringPath(contextDirFor(dir)));
    assert.ok(g, "graph built");
    assert.ok(!g!.nodes.some((n) => n.path === "lib.rs"), "failed file has no file node");

    // The extract cache must remember the failure, not an empty success: an
    // incremental rebuild re-parses the unchanged file (the failure can belong to
    // the run, not the bytes; see graph/build.ts) and reports the error again.
    const second = await buildGraph(dir, { reuse: true });
    assert.equal(second.failed, 1, "a cached failure is re-parsed, not replayed");
    assert.equal(second.parsed, 0, "and failing again does not count as parsed");
    assert.equal(second.errors.length, 1, `error reported again (got: ${second.errors.join("; ")})`);
    assert.match(second.errors[0], /rust grammar threw/);
  } finally {
    swapGrammarForTest("rust", prev);
  }
});
