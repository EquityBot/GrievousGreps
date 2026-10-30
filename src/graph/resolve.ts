/**
 * Resolve {@link RawEdge} intents into concrete {@link EdgeV1} edges by matching
 * names/specifiers against the whole-repo node index.
 *
 * Confidence is a two-tier provenance model:
 *   - `extracted`: the target is certain — a match within the same file, an
 *     import specifier, or a structural containment.
 *   - `inferred`: a bare function target was resolved by a unique name match
 *     across files, which name-shadowing could in principle fool.
 * Ambiguous cross-file matches (a name defined in several files) are dropped
 * rather than guessed. Member calls are stricter: they require a receiver type
 * and owner-qualified method match because a unique bare method name says
 * nothing about the receiver.
 */
import { posix } from "node:path";
import { toPosixPath } from "../util/paths.js";
import type { EdgeV1, Kind, NodeV1, Relation, UnresolvedCallV1 } from "./types.js";
import { languageOf, type PythonExports, type TsModule, type RawEdge } from "./extract.js";
import { PythonModules } from "./python-roots.js";
import { genericLangOf } from "./generic.js";

const IMPORT_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py"];
/** C/C++ source + header extensions, for resolving `#include` targets. */
const C_EXT = /\.(c|h|cc|cpp|cxx|hpp|hh|hxx|inl|ipp|c\+\+|h\+\+)$/i;
/** Python source + stub extensions, for the constructor-call fallback below. */
const PY_EXT = /\.pyi?$/i;
/** What a bare Python call falls back to when no function of that name exists:
 * construction. Only `class` — Python enums, dataclasses and NamedTuples are all
 * classes, so no other kind is reachable this way. */
const PY_CTOR_KINDS: Kind[] = ["class"];
/** Swift is Python's case with more nominal kinds: `Animal(legs: 4)` is an ordinary
 * call node with no `new` to mark construction, and struct/enum initializers are as
 * routine as class ones (a struct gets a memberwise init for free). Same fallback
 * shape — types are tried only once functions (and methods, see extract.ts's
 * implicit-self widening) have found nothing. */
const SWIFT_EXT = /\.swift$/i;
const SWIFT_CTOR_KINDS: Kind[] = ["class", "struct", "enum"];

/**
 * Languages whose symbols can genuinely reach each other. A call edge may not
 * cross a family boundary.
 *
 * This exists because name resolution is repo-wide and used to be language-blind.
 * A Go file calling the builtin `make(...)` has nothing in the repo to resolve
 * against, so the unique-global fallback below matched a TypeScript helper named
 * `make` in a frontend test file — and then every `make(map[...])` in the backend
 * became an edge into that file. One symbol collected 1040 in-edges across 476
 * files, and any pull request touching that test dragged the entire Go backend
 * into its blast radius. Uniqueness is what made it fire: the rarer the collision,
 * the more confident the old code was that it had found the right target.
 *
 * Only real interop is grouped here. TS/TSX/JS import each other freely; Kotlin,
 * Scala and Clojure compile against Java on one classpath; C and C++ share
 * headers. Everything else stands alone.
 */
const FAMILIES: ReadonlyArray<readonly string[]> = [
  ["typescript", "tsx"],
  ["java", "kotlin", "scala", "clojure"],
  ["c", "cpp"],
];
const FAMILY_OF = new Map<string, string>();
for (const group of FAMILIES) for (const lang of group) FAMILY_OF.set(lang, group[0]);

/**
 * The language family a path belongs to, or null when no tier claims the file.
 * A language of its own is its own family, so the common case needs no entry above.
 */
function familyOf(path: string): string | null {
  const lang = languageOf(path) ?? genericLangOf(path)?.name ?? null;
  if (!lang) return null;
  return FAMILY_OF.get(lang) ?? lang;
}

/**
 * Could a reference in `file` reach a definition in `candidatePath`?
 *
 * An unknown family never filters: absence of data is not evidence of a mismatch,
 * and refusing edges for every extension graft cannot name would lose real ones.
 */
function reachable(file: string, candidatePath: string): boolean {
  const from = familyOf(file);
  if (from === null) return true;
  const to = familyOf(candidatePath);
  return to === null || from === to;
}

/** A Go module discovered in the repo: its `module` path from `go.mod` and the repo
 * directory that `go.mod` lives in (posix, `.` for the repo root). A monorepo may hold
 * several — e.g. `backend/go.mod`, `tools/go.mod`. */
export interface GoModule {
  module: string;
  dir: string;
}

export interface ResolveOptions {
  /** The Go modules found in the repo. Enables mapping Go import package paths
   * (`example.com/app/pkg/util`) to the in-repo directory they name, relative to the
   * owning module's `go.mod` location. Empty/absent → Go imports stay external strings. */
  goModules?: GoModule[];
  /** The path aliases the repo's tsconfig files state. */
  tsPaths?: TsPaths[];
  tsPackages?: TsPackage[];
  /** The crates the repo's Cargo.toml files depend on from outside it, `-` as `_`. */
  rustExternalCrates?: ReadonlySet<string>;
  /** Each of the repo's crates, `-` as `_`, to its folder. */
  rustCrateDirs?: ReadonlyMap<string, string>;
  /** The Python roots the repo's configuration states (see python-roots.ts). */
  pythonRoots?: string[];
  /** Filled with the Python calls an import names but no edge carries. */
  unresolvedCalls?: UnresolvedCallV1[];
}

export function resolveEdges(
  nodes: NodeV1[],
  rawEdges: RawEdge[],
  opts: ResolveOptions = {},
): EdgeV1[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const globalName = new Map<string, NodeV1[]>();
  const perFileName = new Map<string, Map<string, NodeV1[]>>();
  // Owner-qualified method index: "Owner.method" → candidate method nodes, for
  // typed member-call resolution (recvType + name → a specific class's method).
  const ownerMethod = new Map<string, NodeV1[]>();
  // Go package resolution: dir (posix) → its `.go` file node ids, for import mapping.
  const goFilesByDir = new Map<string, string[]>();
  // Java package resolution: a file's package-path suffix (`com/acme/Foo.java`) → its
  // file node ids. A Java import names a type by its fully-qualified name, which by
  // language convention mirrors the directory path under whatever source root the
  // project uses (`src/main/java/`, `src/`, …) — so the suffix is the portable key.
  const javaFilesBySuffix = new Map<string, string[]>();
  // C/C++ header resolution: a file's path-suffix (`net/socket.h`, `socket.h`) → its
  // file node ids, so an `#include` reached through an `-I` dir (not relative to the
  // including file) still resolves to the in-repo header when the suffix is unique.
  const cFilesBySuffix = new Map<string, string[]>();
  // Rust crate roots: the directory holding a `lib.rs` or `main.rs`. A `use crate::a::b`
  // resolves to `<crate root>/a/b.rs` (or `.../a/b/mod.rs`), relative to the crate the
  // importing file belongs to — so a workspace with several crates stays unambiguous.
  const rustCrateRoots: string[] = [];
  // PHP class resolution: a file's path-suffix (`Models/User.php`, `User.php`) → its file
  // node ids. A `use App\Models\User` names a PSR-4 class whose file mirrors the namespace
  // tail under some (unknown) source root, so the suffix is the portable key.
  const phpFilesBySuffix = new Map<string, string[]>();
  // Gleam module resolution: a file's path-suffix (`app/thing.gleam`) → its file
  // node ids. A Gleam package roots every module at its own `src/` (or `test/`),
  // so an `import app/thing` is exactly that suffix under some unknown root.
  const gleamFilesBySuffix = new Map<string, string[]>();
  const hasGoModules = !!opts.goModules?.length;
  for (const n of nodes) {
    if (n.kind === "file") {
      if (hasGoModules && n.path.endsWith(".go")) {
        const dir = posix.dirname(toPosixPath(n.path));
        push(goFilesByDir, dir, n.id);
      }
      if (n.path.endsWith(".java")) {
        // Index every directory-boundary suffix, since the source root is unknown:
        // `src/main/java/com/acme/Foo.java` is reachable as `com/acme/Foo.java`,
        // `acme/Foo.java`, and so on. The import's own FQN picks the right depth.
        const parts = toPosixPath(n.path).split("/");
        for (let i = 0; i < parts.length; i++) push(javaFilesBySuffix, parts.slice(i).join("/"), n.id);
      }
      if (C_EXT.test(n.path)) {
        const parts = toPosixPath(n.path).split("/");
        for (let i = 0; i < parts.length; i++) push(cFilesBySuffix, parts.slice(i).join("/"), n.id);
      }
      if (n.path.endsWith(".php")) {
        const parts = toPosixPath(n.path).split("/");
        for (let i = 0; i < parts.length; i++) push(phpFilesBySuffix, parts.slice(i).join("/"), n.id);
      }
      if (n.path.endsWith(".gleam")) {
        const parts = toPosixPath(n.path).split("/");
        for (let i = 0; i < parts.length; i++) push(gleamFilesBySuffix, parts.slice(i).join("/"), n.id);
      }
      {
        const p = toPosixPath(n.path);
        if (p === "lib.rs" || p === "main.rs") rustCrateRoots.push("");
        else if (p.endsWith("/lib.rs") || p.endsWith("/main.rs")) rustCrateRoots.push(posix.dirname(p));
      }
      continue;
    }
    push(globalName, n.name, n);
    let fileMap = perFileName.get(n.path);
    if (!fileMap) perFileName.set(n.path, (fileMap = new Map()));
    push(fileMap, n.name, n);
    // A generic-tier Rust `impl` item is a `function` that knows its owner.
    if (n.kind === "method" || (n.kind === "function" && n.owner)) {
      const owner = n.owner ?? ownerFromMethodId(n.id);
      if (owner) push(ownerMethod, `${owner}.${n.name}`, n);
    }
  }

  // classParents: class/interface name → its declared base-class names, from raw
  // `extends` edges (source id's own name → the base name). Used to walk up an
  // inheritance chain when a receiver's own type has no matching method.
  const classParents = new Map<string, string[]>();
  for (const e of rawEdges) {
    if (e.relation !== "extends" || !e.name) continue;
    // The declaring class's own bare name — read from its node (keyed by n.name, set
    // once at mint time) rather than re-derived by slicing e.source, which breaks once
    // ids can carry a dedup ordinal (A3's `Cache~2`).
    const ownName = byId.get(e.source)?.name;
    if (!ownName) continue;
    push(classParents, ownName, e.name);
  }

  // classTraits: class name → trait names from raw `implements` edges in PHP files.
  // PHP models `use SomeTrait;` as implements; trait methods live on the trait owner,
  // not the using class, so resolveTypedMember walks these after the class lookup fails.
  const classTraits = new Map<string, string[]>();
  for (const e of rawEdges) {
    if (e.relation !== "implements" || !e.name || !e.file.endsWith(".php")) continue;
    const ownName = byId.get(e.source)?.name;
    if (!ownName) continue;
    push(classTraits, ownName, e.name);
  }

  const out: EdgeV1[] = [];
  const seen = new Set<string>();
  const add = (source: string, target: string, relation: Relation, confidence: EdgeV1["confidence"]) => {
    const key = `${source}\0${relation}\0${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ source, target, relation, confidence });
  };

  // A Rust alias reads in its own module, or where something brings it in, by a name only
  // one alias and no type holds. Each hop then reads from the alias's own place.
  const rustAliases = new Map<string, (NonNullable<RawEdge["rustAlias"]> & { file: string })[]>();
  for (const e of rawEdges) {
    if (!e.rustAlias) continue;
    const list = rustAliases.get(e.rustAlias.alias) ?? [];
    list.push({ ...e.rustAlias, file: e.file });
    rustAliases.set(e.rustAlias.alias, list);
  }
  const rustRealType = (type: string, from: string, fromAt: number, brought: boolean): { type: string; root?: string } => {
    let real: { type: string; root?: string } = { type };
    let [file, at, open] = [from, fromAt, brought];
    for (let hops = 0; hops < 4; hops++) {
      const list = rustAliases.get(real.type);
      const here = list?.filter((a) => a.file === file && a.start <= at && at < a.end).sort((x, y) => (x.end - x.start) - (y.end - y.start))[0];
      const next = here ?? (open && list?.length === 1 && !(globalName.get(real.type) ?? []).some((n) => RUST_OWNER_KINDS.has(n.kind) && n.path !== list[0].file) ? list[0] : undefined);
      if (!next) return real;
      real = { type: next.target, root: next.root };
      [file, at, open] = [next.file, next.start, false];
    }
    return real;
  };

  const rustPubUses = new Map<string, NonNullable<RawEdge["rustPubUses"]>>();
  for (const e of rawEdges) if (e.rustPubUses) rustPubUses.set(e.file, e.rustPubUses);
  const rustPathCtx: RustPathCtx = { crates: opts.rustCrateDirs ?? new Map(), byId, perFileName, pubUses: rustPubUses };

  const tsModules = new Map<string, TsModule>();
  for (const e of rawEdges) if (e.tsModule) tsModules.set(e.file, e.tsModule);
  const tsCtx: TsCtx = { modules: tsModules, perFileName, byId, paths: opts.tsPaths ?? [], packages: opts.tsPackages ?? [], repoPaths: tsRepoPaths(byId) };

  const pythonExports = new Map<string, PythonExports>();
  for (const e of rawEdges) if (e.pythonExports) pythonExports.set(e.file, e.pythonExports);
  const pythonModules = new PythonModules(
    nodes.filter((n) => n.kind === "file" && n.path.endsWith(".py")).map((n) => toPosixPath(n.path)),
    opts.pythonRoots,
  );
  const pythonCtx: PythonCtx = { modules: pythonModules, perFileName, exports: pythonExports, ownerMethod, classParents, classTraits };

  for (const e of rawEdges) {
    if (e.relation === "contains" && e.targetId) {
      add(e.source, e.targetId, "contains", "extracted");
    } else if (e.relation === "imports" && e.specifier) {
      const target =
        hasGoModules && e.file.endsWith(".go")
          ? resolveGoImport(e.specifier, opts.goModules!, goFilesByDir)
          : e.file.endsWith(".java")
            ? resolveJavaImport(e.specifier, javaFilesBySuffix)
            : C_EXT.test(e.file)
              ? resolveCInclude(e.specifier, e.file, byId, cFilesBySuffix)
              : e.file.endsWith(".rs")
                ? resolveRustUse(e.specifier, e.file, byId, rustCrateRoots)
                : e.file.endsWith(".php")
                  ? resolvePhpUse(e.specifier, phpFilesBySuffix)
                  : e.file.endsWith(".gleam")
                    ? resolveGleamImport(e.specifier, gleamFilesBySuffix)
                  : e.file.endsWith(".py")
                    ? pythonImportTarget(e.specifier, e.file, pythonModules)
                    : resolveImport(e.specifier, e.file, byId);
      add(e.source, target, "imports", "extracted");
    } else if (e.relation === "extends" || e.relation === "implements") {
      // `implements` also resolves to a `trait` — PHP models trait composition
      // (`use SomeTrait;`) as an implements edge, and a trait is a valid target.
      const kinds: Kind[] = e.relation === "implements" ? ["interface", "trait"] : ["class", "interface"];
      const hit = resolveName(e.name!, e.file, kinds, perFileName, globalName);
      // an unresolved base is usually an external/imported type — keep the name.
      add(e.source, hit?.id ?? e.name!, e.relation, hit?.confidence ?? "inferred");
    } else if (e.relation === "references" && e.name) {
      if (e.specifier) {
        // A named import gives both halves needed for sound resolution: the module
        // it came from and the exported name. Resolve inside that file only, so a
        // same-named symbol elsewhere in the repo cannot become a false edge.
        const targetFile = e.file.endsWith(".php")
          ? resolvePhpUse(e.specifier, phpFilesBySuffix)
          : e.file.endsWith(".gleam")
            ? resolveGleamImport(e.specifier, gleamFilesBySuffix)
            : resolveImport(e.specifier, e.file, byId);
        if (!byId.has(targetFile)) continue; // external or unresolved module
        const candidates = narrowGleamByKind(perFileName.get(targetFile)?.get(e.name) ?? [], e.file, TYPE_KINDS);
        if (candidates.length === 1) add(e.source, candidates[0].id, "references", "extracted");
      } else if (e.file.endsWith(".php") && byId.get(e.source)?.origin === "ast") {
        // PHP attribute without a `use` import (same-file or globally unique class).
        const refKinds: Kind[] = ["class", "interface", "trait", "enum"];
        const hit = resolveName(e.name, e.file, refKinds, perFileName, globalName);
        if (hit && hit.id !== e.source) add(e.source, hit.id, "references", hit.confidence);
      } else if (e.file.endsWith(".java") && byId.get(e.source)?.origin === "ast") {
        // Java annotation without a specifier (same-file or globally unique
        // `@interface`). Annotation types are `interface` kind — a class of the
        // same name is not a match, so `@Entity` cannot collapse onto an in-repo
        // `class Entity` (#103). Kind alone still cannot tell `@interface Service`
        // from `interface Service`, so only accept a candidate whose header
        // contains the literal `@interface` (`includes`, not `startsWith`: a
        // meta-annotated type is `@Documented @Retention(...) public @interface
        // JsonAdapter`). Unresolved targets keep the bare name, matching
        // heritage, rather than dropping the way PHP attributes do.
        const refKinds: Kind[] = ["interface"];
        const hit = resolveName(e.name, e.file, refKinds, perFileName, globalName);
        const anno = hit ? byId.get(hit.id) : undefined;
        if (hit && hit.id !== e.source && anno?.signature?.includes("@interface"))
          add(e.source, hit.id, "references", hit.confidence);
        else add(e.source, e.name, "references", "inferred");
      } else if (byId.get(e.source)?.origin === "generic") {
        // Breadth tier: a bare-name structural reference (extends / implements /
        // object-creation / module alias) the grammar marked but cannot type. Resolve
        // to a type-like definition, drop-rather-than-guess, never a self-loop. Gated on
        // generic origin so depth-tier references (which always carry a specifier) are
        // provably untouched.
        const refKinds: Kind[] = ["class", "interface", "struct", "enum", "type", "module"];
        const hit = resolveName(e.name, e.file, refKinds, perFileName, globalName);
        if (hit && hit.id !== e.source) add(e.source, hit.id, "references", hit.confidence);
      }
    } else if (e.relation === "calls") {
      // Gleam (generic.ts's module pass): the call carries the module it targets —
      // a qualified `list.map(…)` or a `{ … }`-imported bare name. That is both
      // halves of a sound resolution, so look the name up in that module's file
      // alone. A module that is not an in-repo file is the stdlib or a hex
      // dependency: there is nothing to point at, and its labels (`map`, `try`,
      // `new`) collide with in-repo names constantly, so the call drops.
      if (e.specifier && e.file.endsWith(".gleam")) {
        const targetFile = resolveGleamImport(e.specifier, gleamFilesBySuffix);
        if (!byId.has(targetFile)) continue;
        const candidates = narrowGleamByKind(perFileName.get(targetFile)?.get(e.name!) ?? [], e.file, CALLABLE_KINDS);
        if (candidates.length === 1) add(e.source, candidates[0].id, "calls", "extracted");
        continue;
      }
      // A TS or JS import names the module, so the name's own definition is found through
      // it, and an import from outside the repo binds the name to something the graph does
      // not hold. A dotted call that is not a walk through modules is left to receiver typing.
      if (e.tsPath) {
        const hit = followTsCall(e.tsPath, e.name!, toPosixPath(e.file), tsCtx);
        if (hit === "unmapped") {
          const bound = tsCtx.modules.get(toPosixPath(e.file))?.imports.find((i) => i.local === (e.tsPath![0] ?? e.name));
          opts.unresolvedCalls?.push({ source: e.source, name: e.name!, through: bound?.specifier ?? null });
          continue;
        }
        if (hit === "undecided" || (hit === "outside" && e.tsPath.length === 0)) continue;
        if (hit !== "outside") {
          const node = "scoped" in hit ? hit.scoped : hit;
          if (node.id !== e.source) add(e.source, node.id, "calls", "scoped" in hit ? "inferred" : "extracted");
          continue;
        }
      }
      // Python imports identify the target module. A named receiver can be a
      // class or a submodule; both resolve within their explicit import path.
      if (e.rustRoot && (RUST_STD_CRATES.has(e.rustRoot) || opts.rustExternalCrates?.has(e.rustRoot))) continue;
      if (e.pythonRebound && e.name) {
        const file = toPosixPath(e.file);
        const start = e.pythonReboundModule ? pythonModuleName(e.pythonReboundModule, file, pythonCtx) : followPythonName(e.pythonRebound, file, pythonCtx);
        const hit = e.pythonChain ? walkPythonChain(start, e.pythonChain, pythonCtx) : start === "external" ? "external" : "undecided";
        if (hit === "undecided") opts.unresolvedCalls?.push({ source: e.source, name: e.pythonReboundName ?? e.name, through: e.pythonReboundModule ?? null });
        else if (hit !== "external") add(e.source, hit.id, "calls", "extracted");
        continue;
      }
      // Python imports identify the target module; the dotted name walks from there.
      // Explicit imports must not fall through to an unrelated global name.
      if (e.pythonChain && e.specifier && e.name) {
        const hit = walkPythonChain(pythonModuleName(e.specifier, toPosixPath(e.file), pythonCtx), e.pythonChain, pythonCtx);
        if (hit === "undecided") opts.unresolvedCalls?.push({ source: e.source, name: e.name, through: e.specifier });
        else if (hit !== "external") add(e.source, hit.id, "calls", "extracted");
        continue;
      }
      if (e.viaMember) {
        if (!e.recvType) continue;
        const real = e.file.endsWith(".rs") ? rustRealType(e.recvType, e.file, e.rustAt ?? 0, e.rustOwnerBrought === true) : { type: e.recvType };
        if (real.root && opts.rustExternalCrates?.has(real.root)) continue; // an alias of a dependency's type
        const recvType = real.type;
        // An alias names its crate, which picks between the repo's types of that name.
        const crateDir = real.root ? opts.rustCrateDirs?.get(real.root) : undefined;
        const inCrate = crateDir ? (ownerMethod.get(`${recvType}.${e.name}`) ?? []).filter((c) => c.path.startsWith(`${crateDir}/`)) : [];
        let hit = inCrate.length === 1
          ? { id: inCrate[0].id, confidence: "inferred" as const }
          : resolveTypedMember(recvType, e.name!, e.file, ownerMethod, classParents, classTraits, e.argCount);
        for (const bound of e.rustBounds ?? []) {
          hit ??= resolveTypedMember(bound, e.name!, e.file, ownerMethod, classParents, classTraits, e.argCount);
        }
        // A Rust `Type::f` the repo's type holds no single `f` for says so, an enum
        // variant's capital name aside: several
        // `impl From<_>` need argument types to choose between, and a type alias or a
        // trait's default method needs more than the owner index holds.
        // So does a type nothing in the repo declares and no `use` takes from elsewhere, such
        // as a macro's, when the repo defines the name: only the macro knows if it is that one.
        const owned = (globalName.get(e.recvType) ?? []).some((n) => RUST_OWNER_KINDS.has(n.kind));
        const unseen = !owned && !hit && !e.rustBounds?.length && !RUST_PRELUDE_TYPES.has(e.recvType) && !rustAliases.has(e.recvType)
          && e.recvType.length > 1 && (globalName.get(e.name!) ?? []).some((n) => n.kind === "function" || n.kind === "method");
        if (e.file.endsWith(".rs") && (hit === "ambiguous" || !hit) && !/^[A-Z]/.test(e.name!) && (owned || unseen)) {
          opts.unresolvedCalls?.push({ source: e.source, name: e.name!, through: e.recvType });
        }
        if (hit === "ambiguous") continue; // drop — never guess past an ambiguous owner
        if (hit) {
          add(e.source, hit.id, "calls", hit.confidence);
          continue;
        }
        // No owner-qualified match means the call is unresolved. A unique bare
        // method name is not evidence that this receiver has that method — a
        // name-fallback here was measured to HALVE call-edge precision (73%→37%
        // vs a compiler-grade oracle) for a 3x count inflation, i.e. noise. See #35.
        //
        // One carve-out, which is NOT that fallback: a Swift `implicitSelf` edge
        // carries two readings of one bare call — member (tried above, in
        // Swift's own inner-scope-first order) and free function. Zero members
        // on the whole owner chain means the call was a free-function call after
        // all, so it falls through to bare-name resolution; an ambiguous member
        // set has already dropped it above, and a resolved member never reaches
        // here — a name defined as both member and free function yields the
        // member edge alone, exactly as Swift dispatches it.
        if (!e.implicitSelf) continue;
      }
      // Every language's bare-name call is a free function, except R (Phase 4):
      // an untyped `obj$method()` there sets e.kinds to also allow a "method"
      // match — see extract.ts's calleeName R branch for why (R6 methods are
      // never kind "function", so without this every such call would be
      // unconditionally unresolvable rather than just occasionally ambiguous).
      // Three cases, because "a bare call" means something different per tier:
      //
      //  - generic (breadth tier): tags.scm captures ALL calls as bare names, since it
      //    cannot type a receiver. In method-heavy languages those target methods, so
      //    widen to methods — ONLY here, leaving depth-tier precision untouched (an
      //    ambiguous function-vs-method name still drops).
      //  - Java (depth tier): an implicit-`this` call is spelled as a member call in
      //    extract.ts, so the only bare call reaching here is `new Foo()`, whose target
      //    is a TYPE. Against the function index every constructor edge would drop.
      //  - everything else: functions, exactly as before.
      //
      // R (depth tier, Phase 4) sets `e.kinds` itself for an untyped `obj$method()`
      // (see above), and that explicit choice wins over the per-tier default.
      const srcOrigin = byId.get(e.source)?.origin;
      const callKinds: Kind[] =
        e.kinds ??
        (srcOrigin === "generic"
          ? ["function", "method"]
          : e.file.endsWith(".java")
            ? ["class", "struct", "enum", "interface"]
            : ["function"]);
      if (e.rustForm) {
        if (e.rustPath && e.rustForm !== "macro") {
          const reached = rustFollowPath(e.rustPath, e.file, rustPathCtx);
          if (reached) {
            if (reached.id !== e.source) add(e.source, reached.id, "calls", "extracted");
            continue;
          }
        }
        const isMacro = (n: NodeV1) => !!n.signature?.startsWith("macro_rules!");
        const fits = (n: NodeV1) => n.kind === "function"
          && (e.rustForm === "macro" ? isMacro(n) : e.rustForm === "method" ? !!n.owner : !n.owner && !isMacro(n));
        const free = (list: NodeV1[] | undefined) => (list ?? []).filter(fits);
        const local = free(perFileName.get(e.file)?.get(e.name!));
        const inModule = (path: string) =>
          !e.onlyModules || e.onlyModules.some((m) => path.endsWith(`/${m}.rs`) || path.includes(`/${m}/`));
        const global = free(globalName.get(e.name!)).filter((n) => reachable(e.file, n.path) && inModule(n.path));
        const only = local.length === 1 ? local[0] : global.length === 1 ? global[0] : undefined;
        if (only) add(e.source, only.id, "calls", local.length === 1 ? "extracted" : "inferred");
        else if (global.length > 1 && e.rustForm === "free") opts.unresolvedCalls?.push({ source: e.source, name: e.name!, through: e.rustPath ?? `${global.length} definitions of that name` });
        continue;
      }
      let hit = resolveName(e.name!, e.file, callKinds, perFileName, globalName);
      // Python is the Java case without the `new` to mark it: `Widget()` is an
      // ordinary call node, so a constructor edge dies against the function-only
      // index. Java can widen to types outright; Python has free functions, so
      // widening would trade real function edges for type ones. Hence a fallback,
      // not a swap — types are tried only once functions have found nothing, and
      // resolveName's same-file-then-unique-global rule still drops the ambiguous.
      if (!hit && PY_EXT.test(e.file)) {
        hit = resolveName(e.name!, e.file, PY_CTOR_KINDS, perFileName, globalName);
      }
      if (!hit && SWIFT_EXT.test(e.file)) {
        hit = resolveName(e.name!, e.file, SWIFT_CTOR_KINDS, perFileName, globalName);
      }
      if (hit) add(e.source, hit.id, "calls", hit.confidence); // drop unresolved calls (too noisy)
    }
  }
  return out;
}

function push<T>(map: Map<string, T[]>, key: string, val: T): void {
  const arr = map.get(key);
  if (arr) arr.push(val);
  else map.set(key, [val]);
}

/** Derive a method's owner from its dotted id when extract did not stamp `owner`
 * (PHP trait/interface methods today). `app.php#Loggable.log` → `Loggable`. */
function ownerFromMethodId(id: string): string | undefined {
  const post = id.includes("#") ? id.split("#")[1] : id;
  const segs = post.split(".");
  return segs.length >= 2 ? segs[segs.length - 2] : undefined;
}

/**
 * Resolve a bare symbol name: same-file match first (certain → `extracted`),
 * else a unique cross-file match (→ `inferred`), else null (ambiguous/unknown).
 */
function resolveName(
  name: string,
  file: string,
  kinds: Kind[],
  perFileName: Map<string, Map<string, NodeV1[]>>,
  globalName: Map<string, NodeV1[]>,
): { id: string; confidence: EdgeV1["confidence"] } | null {
  const local = (perFileName.get(file)?.get(name) ?? []).filter((n) => kinds.includes(n.kind));
  // Same-file requires a UNIQUE match, exactly as the cross-file branch below does.
  // Returning `local[0]` meant a file holding two same-named types (`Alpha.Builder` and
  // `Beta.Builder`, `Alpha.Inner` and `Beta.Inner`) silently resolved to whichever came
  // first in document order — and labelled it `extracted`, i.e. certain. That is the
  // guess this module's header says it does not make.
  if (local.length === 1) return { id: local[0].id, confidence: "extracted" };
  // Cross-file: also require a language that could actually reach this one.
  // Without it a unique name match ANYWHERE in the repo wins, which is how a Go
  // builtin ended up resolving into a TypeScript test — see FAMILIES above.
  const global = (globalName.get(name) ?? []).filter(
    (n) => kinds.includes(n.kind) && reachable(file, n.path),
  );
  if (global.length === 1) return { id: global[0].id, confidence: "inferred" };
  return null;
}

/**
 * Resolve a typed member call (`recvType.name`) against the owner-qualified method
 * index, walking the receiver's extends chain when its own type has no match.
 *
 * Returns:
 *   - `{ id, confidence }` — resolved: a single candidate at some owner level (or the
 *     same-file one among several).
 *   - `"ambiguous"` — several candidates at some owner level and none is same-file;
 *     per the inviolable philosophy we drop and stop rather than guess, and we do
 *     NOT continue up the chain past this level.
 *   - `null` — the whole chain (recvType + ancestors, breadth-first, depth ≤ 3,
 *     cycle-guarded) had zero candidates at every level.
 */
/**
 * Narrow an overload set to the candidates a call of `argCount` arguments could
 * reach. Only Java emits `argCount`/`arity`, so for every other language this is
 * the identity function and resolution is byte-for-byte what it was.
 *
 * Deliberately conservative in both directions:
 *   - A variadic candidate (`String... xs`) accepts anything from `arity - 1`
 *     upward, so it is never filtered out by count.
 *   - A candidate with no recorded arity (a graph built before this field) is
 *     kept, since absence of data is not evidence of a mismatch.
 *   - If narrowing leaves nothing, the ORIGINAL set is returned. An empty result
 *     would silently drop a real edge; handing the full set back lets the existing
 *     same-file / "ambiguous" logic make the call exactly as before.
 */
function narrowByArity(candidates: NodeV1[], argCount?: number): NodeV1[] {
  if (argCount === undefined || candidates.length < 2) return candidates;
  const fits = candidates.filter((c) => {
    if (c.arity === undefined) return true;
    return c.variadic ? argCount >= c.arity - 1 : c.arity === argCount;
  });
  return fits.length > 0 ? fits : candidates;
}

function resolveTypedMember(
  recvType: string,
  name: string,
  file: string,
  ownerMethod: Map<string, NodeV1[]>,
  classParents: Map<string, string[]>,
  classTraits: Map<string, string[]>,
  argCount?: number,
): { id: string; confidence: EdgeV1["confidence"] } | "ambiguous" | null {
  const MAX_DEPTH = 3;
  const visited = new Set<string>([recvType]);
  let frontier = [recvType];
  for (let depth = 0; depth <= MAX_DEPTH && frontier.length; depth++) {
    for (const type of frontier) {
      const all = ownerMethod.get(`${type}.${name}`)?.filter((c) => reachable(file, c.path));
      if (all && all.length > 0) {
        const candidates = narrowByArity(all, argCount);
        if (candidates.length === 1) {
          const c = candidates[0];
          return { id: c.id, confidence: c.path === file ? "extracted" : "inferred" };
        }
        // Swift: several candidates surviving arity narrowing are a genuine
        // overload set distinguished only by parameter TYPES (`save(Int)` vs
        // `save(String)`), which this pass cannot read — the same-file tiebreak
        // below would pick whichever overload appears first in the file and
        // stamp it `extracted`, a confidently wrong edge. Drop instead.
        if (SWIFT_EXT.test(file)) return "ambiguous";
        // Rust is the same within a file, where each `impl From<_>` holds its own `from`.
        // The tiebreak below still chooses this file's type over another crate's namesake.
        if (file.endsWith(".rs") && candidates.filter((c) => c.path === file).length > 1) return "ambiguous";
        const sameFile = candidates.find((c) => c.path === file);
        if (sameFile) return { id: sameFile.id, confidence: "extracted" };
        return "ambiguous"; // several, none same-file — drop and stop
      }
      const traitHit = resolveTraitMember(type, name, file, ownerMethod, classTraits, argCount);
      if (traitHit === "ambiguous") return "ambiguous";
      if (traitHit) return traitHit;
    }
    const next: string[] = [];
    for (const type of frontier) {
      for (const parent of classParents.get(type) ?? []) {
        if (visited.has(parent)) continue;
        visited.add(parent);
        next.push(parent);
      }
    }
    frontier = next;
  }
  return null; // chain exhausted, no candidate anywhere
}

/** Resolve a member call against methods declared on PHP traits used by `type`. */
function resolveTraitMember(
  type: string,
  name: string,
  file: string,
  ownerMethod: Map<string, NodeV1[]>,
  classTraits: Map<string, string[]>,
  argCount?: number,
): { id: string; confidence: EdgeV1["confidence"] } | "ambiguous" | null {
  const traits = classTraits.get(type);
  if (!traits?.length) return null;
  const matches: NodeV1[] = [];
  for (const trait of traits) {
    const all = ownerMethod.get(`${trait}.${name}`)?.filter((c) => reachable(file, c.path));
    if (!all?.length) continue;
    matches.push(...narrowByArity(all, argCount));
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) {
    const c = matches[0];
    return { id: c.id, confidence: c.path === file ? "extracted" : "inferred" };
  }
  return "ambiguous";
}

/**
 * Resolve a Python import's dotted module path to an in-repo file node id;
 * otherwise return the raw specifier (stdlib or third-party package).
 *
 * Two shapes, one answer. A RELATIVE import (`.service`, `..core.config`) states
 * its anchor: one leading dot is the importing file's own package, each further
 * dot climbs one level, so the path is computed, not searched. An ABSOLUTE import
 * (`app.db.session`) names a module relative to a sys.path root the repo never
 * writes down — it may be the repo root, a `src/` dir, or a package dir — so the
 * dotted tail is matched against each file's importable path SUFFIX, exactly the
 * root-agnostic key Java and PHP imports use here.
 *
 * A suffix shared by two files (`a/util.py` and `b/util.py` for `import util`) is
 * left unresolved: picking one would invent an edge the source does not state.
 */
const RUST_STD_CRATES = new Set(["std", "core", "alloc"]);
/** Types and traits every Rust file sees without a `use`. */
const RUST_PRELUDE_TYPES = new Set(["Box", "Clone", "Default", "From", "Into", "Iterator", "IntoIterator", "Option", "Result", "String", "ToOwned", "ToString", "TryFrom", "TryInto", "Vec", "Extend", "FromIterator", "PartialEq", "PartialOrd", "Ord", "Eq", "Drop", "Fn", "FnMut", "FnOnce", "AsRef", "AsMut", "DoubleEndedIterator", "ExactSizeIterator", "Send", "Sync", "Sized", "Copy", "Self"]);
const RUST_OWNER_KINDS: ReadonlySet<Kind> = new Set<Kind>(["struct", "enum", "trait", "type", "class", "interface"]);

/** Where a name in a Python module leads: its definition, a module it binds, or why
 * there is neither. `external`: bound from outside the repo, so no in-repo node is its
 * target. `undecided`: an in-repo name this walk cannot pin to one definition. */
type PythonName = NodeV1 | { module: string } | "external" | "undecided";

interface RustPathCtx {
  crates: ReadonlyMap<string, string>;
  byId: Map<string, NodeV1>;
  perFileName: Map<string, Map<string, NodeV1[]>>;
  pubUses: Map<string, NonNullable<RawEdge["rustPubUses"]>>;
}

/** The crate folder a file sits in: the deepest one above it. */
function rustCrateOf(file: string, ctx: RustPathCtx): string | undefined {
  let best: string | undefined;
  for (const dir of ctx.crates.values()) {
    if ((dir === "." || file.startsWith(`${dir}/`)) && (best === undefined || dir.length > best.length)) best = dir;
  }
  return best;
}

/** The file a module path within a crate's `src` lands on, and the path left after it, which
 * is an inline module, a type or a re-export. The crate root when nothing further matches. */
function rustModuleFile(crate: string, parts: string[], ctx: RustPathCtx): { file: string; left: string[] } | undefined {
  const at = (rel: string) => (crate === "." ? rel : `${crate}/${rel}`);
  for (let n = parts.length; n >= 1; n--) {
    const stem = at(`src/${parts.slice(0, n).join("/")}`);
    for (const file of [`${stem}.rs`, `${stem}/mod.rs`]) if (ctx.byId.has(file)) return { file, left: parts.slice(n) };
  }
  for (const file of [at("src/lib.rs"), at("src/main.rs")]) if (ctx.byId.has(file)) return { file, left: parts };
  return undefined;
}

/** A file's own module path within its crate's `src`, or undefined outside `src`. */
function rustModuleOf(file: string, crate: string): string[] | undefined {
  const rel = crate === "." ? file : file.slice(crate.length + 1);
  if (!rel.startsWith("src/")) return undefined;
  const parts = rel.slice(4).replace(/\.rs$/, "").split("/");
  const last = parts.at(-1);
  if (last === "mod" || (parts.length === 1 && (last === "lib" || last === "main"))) parts.pop();
  return parts;
}

/**
 * The free function a whole Rust path names, followed through the workspace's crates, its
 * module files and their `pub use` lines. Undefined when the path leaves what those show,
 * and the caller falls back on the name.
 *
 * shortcut: reads module paths from the file tree, so a `#[path]` attribute is not followed,
 * and a path reaching a name 2 `cfg` arms define in one file is left to the fallback.
 */
function rustFollowPath(whole: string, file: string, ctx: RustPathCtx, depth = 0): NodeV1 | undefined {
  if (depth > 5) return undefined;
  const segs = whole.split("::");
  const name = segs.pop()!;
  const crateHere = rustCrateOf(file, ctx);
  let crate: string | undefined;
  let parts: string[];
  const first = segs[0];
  if (first === "crate") {
    crate = crateHere;
    parts = segs.slice(1);
  } else if (first === "self" || first === "super") {
    const here = crateHere === undefined ? undefined : rustModuleOf(file, crateHere);
    if (!here) return undefined;
    crate = crateHere;
    let i = 0;
    const base = [...here];
    for (; segs[i] === "self" || segs[i] === "super"; i++) if (segs[i] === "super") base.pop();
    parts = [...base, ...segs.slice(i)];
  } else if (first !== undefined && ctx.crates.has(first)) {
    crate = ctx.crates.get(first);
    parts = segs.slice(1);
  } else if (first !== undefined) {
    // `dispatcher::f` with no `use`: a child module of this file's own.
    const here = crateHere === undefined ? undefined : rustModuleOf(file, crateHere);
    if (!here) return undefined;
    crate = crateHere;
    parts = [...here, ...segs];
  } else {
    return undefined;
  }
  if (crate === undefined) return undefined;
  const landed = rustModuleFile(crate, parts, ctx);
  if (!landed) return undefined;
  const pub = ctx.pubUses.get(landed.file);
  if (landed.left.length) {
    const through = pub?.names.find(([n]) => n === landed.left[0]);
    return through ? rustFollowPath([through[1], ...landed.left.slice(1), name].join("::"), landed.file, ctx, depth + 1) : undefined;
  }
  const own = (ctx.perFileName.get(landed.file)?.get(name) ?? []).filter((n) => n.kind === "function" && !n.owner && !n.signature?.startsWith("macro_rules!"));
  if (own.length === 1) return own[0];
  if (own.length > 1) return undefined;
  const named = pub?.names.find(([n]) => n === name);
  if (named) return rustFollowPath(named[1], landed.file, ctx, depth + 1);
  for (const glob of pub?.globs ?? []) {
    const hit = rustFollowPath(`${glob}::${name}`, landed.file, ctx, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

/** Path aliases for the files under `dir`, whose targets read from `base`. */
export interface TsPaths {
  dir: string;
  base: string;
  paths: Record<string, string[]>;
  /** The config states `baseUrl`, so a bare import may read from `base`. */
  baseUrl?: boolean;
}

/** A package in the repo, and for each subpath the files its manifest points at. */
export interface TsPackage {
  name: string;
  dir: string;
  entries: Record<string, string[]>;
}

interface TsCtx {
  modules: Map<string, TsModule>;
  perFileName: Map<string, Map<string, NodeV1[]>>;
  byId: Map<string, NodeV1>;
  paths: TsPaths[];
  packages: TsPackage[];
  /** Every folder and extensionless file the graph holds, for a `baseUrl` to test against. */
  repoPaths: Set<string>;
}

type TsTarget = { module: string } | { packages: TsPackage[]; rest: string };
/** `scoped`: found by name inside the imported package, not by following its exports. */
type TsName = NodeV1 | TsTarget | { scoped: NodeV1 } | "outside" | "undecided" | "unmapped";

function tsRepoPaths(byId: Map<string, NodeV1>): Set<string> {
  const out = new Set<string>();
  for (const id of byId.keys()) {
    if (id.includes("#")) continue;
    const parts = id.split("/");
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join("/"));
    out.add(id.replace(/\.[^./]+$/, ""));
  }
  return out;
}

/**
 * What an import names. Only an import shown to be outside the repo answers "outside", which
 * stops any guess: not a repo package, and not reached by a tsconfig `paths` or `baseUrl`.
 */
function tsModuleOf(specifier: string, file: string, ctx: TsCtx): TsTarget | "outside" | "unmapped" {
  const target = resolveImport(specifier, file, ctx.byId);
  if (ctx.byId.has(target)) return { module: target };
  if (specifier.startsWith(".")) return "unmapped"; // in the repo by its path, but no file the graph holds
  let inRepo = false;
  // The nearest configs above the file first, and each one's longest matching pattern.
  const configs = ctx.paths
    .filter((c) => c.dir === "" || file.startsWith(`${c.dir}/`))
    .sort((a, b) => b.dir.length - a.dir.length);
  for (const config of configs) {
    const pattern = Object.keys(config.paths)
      .filter((p) => (p.endsWith("*") ? specifier.startsWith(p.slice(0, -1)) : p === specifier))
      .sort((a, b) => b.length - a.length)[0];
    if (pattern !== undefined) {
      const rest = pattern.endsWith("*") ? specifier.slice(pattern.length - 1) : "";
      for (const mapped of config.paths[pattern] ?? []) {
        const found = resolveImport(`./${posix.normalize(posix.join(config.base, mapped.replace("*", rest)))}`, "repo-root", ctx.byId);
        if (ctx.byId.has(found)) return { module: found };
      }
      if (pattern !== "*") inRepo = true; // a catch-all states nothing about this name
    }
    if (config.baseUrl) {
      const found = resolveImport(`./${posix.normalize(posix.join(config.base, specifier))}`, "repo-root", ctx.byId);
      if (ctx.byId.has(found)) return { module: found };
      if (ctx.repoPaths.has(posix.normalize(posix.join(config.base, specifier.split("/")[0])))) inRepo = true;
    }
  }
  const owners = ctx.packages.filter((p) => specifier === p.name || specifier.startsWith(`${p.name}/`));
  const longest = Math.max(0, ...owners.map((p) => p.name.length));
  const packages = owners.filter((p) => p.name.length === longest);
  if (packages.length) return { packages, rest: specifier.slice(longest + 1) };
  return inRepo ? "unmapped" : "outside";
}

/**
 * What an in-repo package exports as `name`, searched in order until something defines it: the
 * files its manifest reaches, then its source tree by the import's own path, then the name
 * anywhere in the package, which the caller marks as inferred. A manifest can point at a stub,
 * a build product or nothing, so no one of them is the answer; "unmapped" says none held it.
 */
function followTsPackage(name: string, target: { packages: TsPackage[]; rest: string }, ctx: TsCtx, seen: Set<string>): TsName {
  const { packages, rest } = target;
  let outside = false; // one condition may forward the name out whilst another defines it
  for (const pkg of packages) {
    const tree = rest ? [`src/${rest}`, rest] : ["src/index", "index"];
    for (const entry of [...tsPackageEntries(pkg, rest ? `./${rest}` : "."), ...tree]) {
      const module = resolveImport(`./${posix.join(pkg.dir, entry)}`, "repo-root", ctx.byId);
      if (!ctx.byId.has(module)) continue;
      const hit = followTsExport(name, module, ctx, new Set(seen));
      if (hit === "outside") outside = true;
      else if (hit !== "undecided" && hit !== "unmapped") return hit;
    }
  }
  if (outside) return "outside";
  // Found by name only if something in the package exports it as that: a rename is the
  // provenance, a private function of that name proves nothing, and 2 definitions are no answer.
  const named = new Map<string, NodeV1>();
  for (const pkg of packages) {
    for (const file of new Set([...ctx.perFileName.keys(), ...ctx.modules.keys()])) {
      if (pkg.dir !== "." && !file.startsWith(`${pkg.dir}/`)) continue;
      const hit = followTsExport(name, file, ctx, new Set(seen));
      if (typeof hit === "string" || !("id" in hit)) continue;
      const table = ctx.modules.get(file);
      const listed = table?.exports.some((x) => x.exported === name) || table?.reexports.some((r) => r.exported === name);
      if ((listed || hit.exported) && (hit.kind === "function" || hit.kind === "class")) named.set(hit.id, hit);
    }
  }
  return named.size === 1 ? { scoped: [...named.values()][0] } : "unmapped";
}

/** The files a package's manifest gives a subpath: its own key, or the longest `*` key that fits. */
function tsPackageEntries(pkg: TsPackage, subpath: string): string[] {
  if (pkg.entries[subpath]) return pkg.entries[subpath];
  let best: { prefix: string; stem: string; targets: string[] } | undefined;
  for (const [key, targets] of Object.entries(pkg.entries)) {
    const star = key.indexOf("*");
    if (star < 0) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (subpath.length <= prefix.length + suffix.length || !subpath.startsWith(prefix) || !subpath.endsWith(suffix)) continue;
    if (!best || prefix.length > best.prefix.length) best = { prefix, stem: subpath.slice(star, subpath.length - suffix.length), targets };
  }
  return best ? best.targets.map((t) => t.replace("*", best.stem)) : [];
}

/** `name` as read through what an import or re-export named. */
function followTsTarget(name: string, target: TsTarget, ctx: TsCtx, seen: Set<string>): TsName {
  return "packages" in target ? followTsPackage(name, target, ctx, seen) : followTsExport(name, target.module, ctx, seen);
}

/** What a name bound at the top of `file` is: its definition, or the import it came from. */
function followTsLocal(name: string, file: string, ctx: TsCtx, seen: Set<string>): TsName {
  const own = (ctx.perFileName.get(file)?.get(name) ?? [])
    .filter((n) => n.id.replace(/~\d+$/, "") === `${file}#${name}` && (n.kind === "function" || n.kind === "class"));
  if (own.length === 1) return own[0];
  const bound = ctx.modules.get(file)?.imports.find((i) => i.local === name);
  if (own.length > 1 || !bound) return "undecided";
  const target = tsModuleOf(bound.specifier, file, ctx);
  if (bound.name === "*" || typeof target === "string") return target;
  return followTsTarget(bound.name, target, ctx, seen);
}

/** What `file` exports as `name`, through barrels and renames. */
function followTsExport(name: string, file: string, ctx: TsCtx, seen = new Set<string>()): TsName {
  const key = `${file}\0${name}`;
  if (seen.has(key)) return "undecided"; // an export cycle defines nothing
  seen.add(key);
  const table = ctx.modules.get(file);
  const forwarded = table?.reexports.find((r) => r.exported === name);
  if (forwarded) {
    const target = tsModuleOf(forwarded.specifier, file, ctx);
    if (forwarded.name === "*" || typeof target === "string") return target;
    return followTsTarget(forwarded.name, target, ctx, seen);
  }
  const listed = table?.exports.find((x) => x.exported === name);
  if (listed) return followTsLocal(listed.local, file, ctx, seen);
  if (name === "default") return "undecided"; // `export *` does not carry a default
  const own = followTsLocal(name, file, ctx, seen);
  if (typeof own !== "string") return own;
  const through = (table?.stars ?? []).map((spec) => {
    const target = tsModuleOf(spec, file, ctx);
    return typeof target === "string" ? target : followTsTarget(name, target, ctx, new Set(seen));
  });
  const identity = (t: Exclude<TsName, string>): string =>
    "id" in t ? t.id : "module" in t ? t.module : "scoped" in t ? t.scoped.id : `${t.packages[0].dir}\0${t.rest}`;
  const found = new Map(through.filter((t) => typeof t !== "string").map((t) => [identity(t), t]));
  if (found.size === 1) return [...found.values()][0];
  if (found.size > 1) return "undecided";
  return through.includes("unmapped") ? "unmapped" : through.includes("outside") ? "outside" : "undecided";
}

/** The definition a TS or JS call reaches through the import that binds its first name.
 * A dotted call that does not walk through whole modules is left to receiver typing. */
function followTsCall(path: string[], name: string, file: string, ctx: TsCtx): NodeV1 | { scoped: NodeV1 } | "outside" | "undecided" | "unmapped" {
  const seen = new Set<string>();
  const called = (at: TsName) => typeof at !== "string" && ("id" in at || "scoped" in at);
  if (path.length === 0) {
    const hit = followTsLocal(name, file, ctx, seen);
    return typeof hit === "string" ? hit : called(hit) ? hit as NodeV1 | { scoped: NodeV1 } : "undecided";
  }
  let at = followTsLocal(path[0], file, ctx, seen);
  for (const part of [...path.slice(1), name]) {
    if (at === "unmapped") return at;
    if (typeof at === "string" || "id" in at || "scoped" in at) return "outside";
    at = followTsTarget(part, at, ctx, new Set(seen));
  }
  if (at === "unmapped") return at;
  return called(at) ? at as NodeV1 | { scoped: NodeV1 } : "outside";
}

interface PythonCtx {
  modules: PythonModules;
  perFileName: Map<string, Map<string, NodeV1[]>>;
  exports: Map<string, PythonExports>;
  ownerMethod: Map<string, NodeV1[]>;
  classParents: Map<string, string[]>;
  classTraits: Map<string, string[]>;
}

function pythonModuleName(spec: string, file: string, ctx: PythonCtx): PythonName {
  const module = ctx.modules.resolve(spec, file);
  return module === "external" ? "external" : module === "ambiguous" ? "undecided" : { module };
}

/** Follow `name` from module `file` as Python would: its own definition, then its
 * explicit imports, then its submodules, then its star imports with the last one first
 * (the later star rebinds). Re-export chains end at the definition. */
function followPythonName(name: string, file: string, ctx: PythonCtx, seen = new Set<string>()): PythonName {
  const key = `${file}\0${name}`;
  if (seen.has(key)) {
    // `from . import mod` in a package's `__init__` asks the package for itself: the
    // answer is the submodule. Any other import cycle defines nothing.
    const sub = ctx.modules.submodule(file, name);
    return sub ? { module: sub } : "undecided";
  }
  seen.add(key);
  const own = (ctx.perFileName.get(file)?.get(name) ?? [])
    .filter((n) => n.id.replace(/~\d+$/, "") === `${file}#${name}` && (n.kind === "function" || n.kind === "class"));
  if (own.length > 1) return "undecided";
  const table = ctx.exports.get(file);
  const imports = (table?.imports ?? []).filter((i) => i.local === name);
  if (own.length === 1) {
    if (imports.length === 0) return own[0];
    // A def and an import of one name: the later binding wins, if both surely run.
    if (imports.some((i) => i.conditional) || table?.conditionalDefs.includes(name)) return "undecided";
    const defLine = Number(/^L(\d+)/.exec(own[0].span ?? "")?.[1] ?? 0);
    if (defLine > Math.max(...imports.map((i) => i.line))) return own[0];
  }
  // `try: from .a import f` / `except: from .b import f` binds one name twice, and all
  // the targets must agree: one in the repo and one outside is not a target.
  const bound = imports.map((i) => {
    const target = pythonModuleName(i.specifier, file, ctx);
    if (!i.name || typeof target === "string" || !("module" in target)) return target;
    return followPythonName(i.name, target.module, ctx, new Set(seen));
  });
  const found = new Map(bound.filter((b) => typeof b !== "string").map((b) => [("id" in b ? b.id : b.module), b]));
  if (bound.includes("undecided") || found.size > 1 || (found.size === 1 && bound.includes("external"))) return "undecided";
  if (found.size === 1) return [...found.values()][0];
  if (bound.length) return "external";
  const sub = ctx.modules.submodule(file, name);
  if (sub) return { module: sub };
  for (const spec of [...(table?.stars ?? [])].reverse()) {
    const target = ctx.modules.resolve(spec, file);
    if (target === "external" || target === "ambiguous") continue;
    const exported = ctx.exports.get(target)?.all;
    if (exported ? !exported.includes(name) : name.startsWith("_")) continue;
    const through = followPythonName(name, target, ctx, seen);
    if (through !== "undecided") return through;
  }
  return "undecided";
}

/** Walk a dotted name from where its first part led to the definition a call reaches. */
function walkPythonChain(start: PythonName, chain: string[], ctx: PythonCtx): NodeV1 | "external" | "undecided" {
  let at = start;
  for (let i = 0; i < chain.length; i++) {
    if (typeof at === "string") return at;
    if ("id" in at) return at.kind === "class" && i === chain.length - 1 ? pythonClassMember(at, chain[i], ctx) : "undecided";
    at = followPythonName(chain[i], at.module, ctx);
  }
  if (typeof at === "string") return at;
  return "id" in at ? at : "undecided";
}

/** A method of a class the walk reached, its own before an inherited one. */
function pythonClassMember(owner: NodeV1, name: string, ctx: PythonCtx): NodeV1 | "undecided" {
  const own = (ctx.ownerMethod.get(`${owner.name}.${name}`) ?? [])
    .filter((n) => n.path === owner.path && n.id.replace(/~\d+$/, "") === `${owner.id}.${name}`);
  if (own.length === 1) return own[0];
  const parents = (ctx.classParents.get(owner.name) ?? []);
  for (const parent of parents) {
    const hit = resolveTypedMember(parent, name, owner.path, ctx.ownerMethod, ctx.classParents, ctx.classTraits);
    if (hit && hit !== "ambiguous") {
      const node = (ctx.perFileName.get(hit.id.split("#")[0])?.get(name) ?? []).find((n) => n.id === hit.id);
      if (node) return node;
    }
  }
  return "undecided";
}

/** The target of an `imports` edge: a file, or the specifier when it is not one. */
function pythonImportTarget(spec: string, file: string, modules: PythonModules): string {
  const module = modules.resolve(spec, toPosixPath(file));
  return module !== "external" && module !== "ambiguous" && !module.endsWith("/") ? module : spec;
}

/**
 * Resolve a module specifier to a file node id when it points inside the repo;
 * otherwise return the raw specifier (external package or unresolved path).
 */
function resolveImport(spec: string, file: string, byId: Map<string, NodeV1>): string {
  if (!spec.startsWith(".")) return spec;
  // Belt-and-braces: `node.path` is posix by construction (`../util/paths.ts`),
  // but this also accepts a hand-written or hand-edited graph.
  const dir = posix.dirname(toPosixPath(file));
  const base = posix.normalize(posix.join(dir, spec)).replace(/\/$/, ""); // `./` names the folder's index, as `.` does
  const noExt = base.replace(/\.(js|jsx|mjs|cjs|ts|tsx|py)$/, "");
  const candidates = [
    base,
    ...IMPORT_EXTS.map((e) => noExt + e),
    ...IMPORT_EXTS.map((e) => `${noExt}/index${e}`),
  ];
  for (const c of candidates) if (byId.has(c)) return c;
  return spec;
}

/**
 * Resolve a Java import's fully-qualified type name to an in-repo file node;
 * otherwise return the raw specifier (JDK or third-party type).
 *
 * Java names a *type*, not a path, and states no source root — `com.acme.Foo` may
 * live under `src/main/java/`, `src/`, or a module dir. Matching on the path SUFFIX
 * (`com/acme/Foo.java`) is therefore root-agnostic and needs no build-file parsing,
 * which is what keeps this deterministic and dependency-free.
 *
 * `import static com.acme.Foo.bar` names a member, so when the full name misses, the
 * last segment is dropped and the enclosing type retried. A wildcard (`com.acme.*`)
 * names a package rather than one file and is deliberately left unresolved: picking a
 * representative would invent an edge the source does not state.
 *
 * A suffix shared by two files (the same FQN under two source roots, e.g. a
 * duplicated test tree) is ambiguous, so it stays unresolved rather than guessing.
 */
function resolveJavaImport(spec: string, filesBySuffix: Map<string, string[]>): string {
  const hit = (fqn: string): string | null => {
    const suffix = `${fqn.split(".").join("/")}.java`;
    const files = filesBySuffix.get(suffix);
    return files && files.length === 1 ? files[0] : null;
  };
  const direct = hit(spec);
  if (direct) return direct;
  // `import static a.b.C.member` → retry as `a.b.C`.
  const dot = spec.lastIndexOf(".");
  if (dot > 0) {
    const enclosing = hit(spec.slice(0, dot));
    if (enclosing) return enclosing;
  }
  return spec;
}

/**
 * Resolve a C/C++ `#include "path"` to an in-repo file node: relative to the including
 * file first (the common case, and certain), else a UNIQUE path-suffix match — which
 * covers a header reached through an `-I` include directory rather than a relative path.
 * Anything ambiguous or not found stays the raw path (a system or out-of-repo header),
 * never a guessed edge.
 */
function resolveCInclude(
  spec: string,
  file: string,
  byId: Map<string, NodeV1>,
  bySuffix: Map<string, string[]>,
): string {
  const dir = posix.dirname(toPosixPath(file));
  const relJoin = posix.normalize(posix.join(dir, spec));
  if (byId.has(relJoin)) return relJoin; // relative to the including file — certain
  const hits = bySuffix.get(spec.replace(/^\.?\//, ""));
  if (hits && hits.length === 1) return hits[0]; // unique suffix — an -I-reached header
  return spec; // system/out-of-repo/ambiguous — keep the string, do not guess
}

/**
 * Resolve a PHP `use` fully-qualified name (`App\Models\User`) to the in-repo class file.
 * PSR-4 maps the namespace to a directory under some (unknown) source root and the class
 * to a `<Class>.php` file, so we match the longest namespace-tail suffix that names exactly
 * one file: `App/Models/User.php`, then `Models/User.php`, then `User.php`. The longest
 * unique match wins; an ambiguous tail or a vendor/out-of-repo class stays the raw name.
 */
function resolvePhpUse(fqn: string, bySuffix: Map<string, string[]>): string {
  const parts = fqn.split("\\").filter(Boolean);
  if (parts.length === 0) return fqn;
  for (let i = 0; i < parts.length; i++) {
    const suffix = `${parts.slice(i).join("/")}.php`;
    const hits = bySuffix.get(suffix);
    if (hits && hits.length === 1) return hits[0];
    if (hits && hits.length > 1) break; // ambiguous at the most specific level — do not guess
  }
  return fqn;
}

const CALLABLE_KINDS: Kind[] = ["function", "method"];
const TYPE_KINDS: Kind[] = ["class", "interface", "struct", "enum", "type", "module"];

/**
 * A Gleam type and its constructor idiomatically share a name — `pub type Cfg {
 * Cfg(…) }` defines both — so a module-scoped lookup finds two candidates and
 * would drop the edge for the single most common shape in the language. The use
 * site says which one it meant: `thing.Cfg(…)` applies the constructor,
 * `x: thing.Cfg` annotates the type. Narrow by kind ONLY when the name is
 * genuinely doubled, so a lone match still resolves whatever its kind, and only
 * for Gleam, leaving every other language's specifier lookup untouched.
 */
function narrowGleamByKind(candidates: NodeV1[], file: string, kinds: Kind[]): NodeV1[] {
  if (candidates.length <= 1 || !file.endsWith(".gleam")) return candidates;
  const narrowed = candidates.filter((c) => kinds.includes(c.kind));
  return narrowed.length ? narrowed : candidates;
}

/**
 * Resolve a Gleam `import app/thing` to the in-repo module file. A Gleam package
 * roots every module at its `src/` (tests at `test/`), so the import path IS the
 * file's path-suffix — `app/thing` → `…/app/thing.gleam` — with no per-package
 * config to consult. Only a unique match resolves; the stdlib, a hex dependency,
 * and a module name that two packages in one repo both define all stay the raw
 * module path, so an import never becomes a guessed file edge.
 */
function resolveGleamImport(spec: string, bySuffix: Map<string, string[]>): string {
  const file = `${toPosixPath(spec)}.gleam`;
  const hits = bySuffix.get(file);
  // A file's own full path names it exactly (generic.ts scopes same-file names
  // this way), even when a nested package has a file ending in the same path.
  if (hits?.includes(file)) return file;
  return hits && hits.length === 1 ? hits[0] : spec;
}

/**
 * Resolve a Rust `crate`-relative module path (`crate/a/b`, from `use crate::a::b::Item`)
 * to the in-repo module file — `<crate root>/a/b.rs` or `<crate root>/a/b/mod.rs`, where
 * the crate root is the `lib.rs`/`main.rs` directory the importing file lives under. The
 * per-file crate root keeps a multi-crate workspace unambiguous. Not found or ambiguous
 * (two roots, both `a/b.rs` and `a/b/mod.rs`) stays a `crate::…` string — never a guess.
 */
function resolveRustUse(spec: string, file: string, byId: Map<string, NodeV1>, crateRoots: string[]): string {
  const full = spec.replace(/^crate\/?/, ""); // "crate/a/b/Item" → "a/b/Item"; "crate" → ""
  const fpath = toPosixPath(file);
  // the crate this file belongs to: the longest root that contains it (workspace-safe)
  const owning = crateRoots
    .filter((r) => r === "" ? true : fpath === r || fpath.startsWith(`${r}/`))
    .sort((a, b) => b.length - a.length);
  // No owning crate root (e.g. an integration test under `tests/`, whose `crate::` is the
  // TEST binary's own root, not a lib) → do NOT search every crate in a workspace: that
  // resolves `crate::util` to some unrelated crate's util.rs. Keep it a string instead.
  if (owning.length === 0) return full === "" ? "crate" : `crate::${full.replace(/\//g, "::")}`;
  const roots = [owning[0]];
  const segs = full === "" ? [] : full.split("/");
  const hitsFor = (rels: string[]): Set<string> => {
    const hits = new Set<string>();
    for (const r of roots) for (const rel of rels) {
      const cand = r === "" ? rel : `${r}/${rel}`;
      if (byId.has(cand)) hits.add(cand);
    }
    return hits;
  };
  // Try the longest module prefix first, shrinking toward — but NOT past — the first
  // segment. `crate::a::b::C` resolves as module `a/b` (C is the item); `crate::net` as
  // module `net`. The first prefix naming exactly one in-repo file wins; two matches at a
  // level are ambiguous → drop rather than guess.
  for (let k = segs.length; k >= 1; k--) {
    const modPath = segs.slice(0, k).join("/");
    const hits = hitsFor([`${modPath}.rs`, `${modPath}/mod.rs`]);
    if (hits.size === 1) return [...hits][0];
    if (hits.size > 1) break;
  }
  // The crate root (`lib.rs`/`main.rs`) is a target ONLY for `use crate::Item` or
  // `use crate::{…}` — a deeper path whose module chain didn't resolve is genuinely
  // unknown (a re-export, an inline `mod`, or out-of-tree), so keep it as a string.
  if (segs.length <= 1) {
    const hits = hitsFor(["lib.rs", "main.rs"]);
    if (hits.size === 1) return [...hits][0];
  }
  return full === "" ? "crate" : `crate::${full.replace(/\//g, "::")}`;
}

/**
 * Resolve a Go import package path to an in-repo file node when it points inside one of
 * the repo's modules; otherwise return the raw specifier (stdlib or third-party package).
 *
 * Go imports name a *package* (a directory), not a file. The package path is relative to
 * the owning module's path, so the in-repo directory is `<module go.mod dir>/<subpath>`.
 * This handles a `go.mod` anywhere in the tree — repo root or a subdirectory (monorepo).
 * When several modules' paths prefix the spec, the longest (most specific) wins. A package
 * dir may hold several `.go` files; we pick a deterministic representative (lowest id).
 */
function resolveGoImport(spec: string, modules: GoModule[], filesByDir: Map<string, string[]>): string {
  let best: { mod: GoModule; subpath: string } | null = null;
  for (const mod of modules) {
    let subpath: string | null = null;
    if (spec === mod.module) subpath = "";
    else if (spec.startsWith(mod.module + "/")) subpath = spec.slice(mod.module.length + 1);
    if (subpath === null) continue;
    if (!best || mod.module.length > best.mod.module.length) best = { mod, subpath };
  }
  if (!best) return spec; // stdlib / third-party — keep the package path

  const dir = posix.normalize(posix.join(best.mod.dir, best.subpath));
  const files = filesByDir.get(dir);
  if (!files || files.length === 0) return spec;
  return [...files].sort()[0];
}
