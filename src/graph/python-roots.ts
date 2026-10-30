/**
 * Python's import search path, worked out from the repo so an absolute import resolves
 * the way Python would: against roots, never against whichever file has a matching
 * suffix. A root is a directory whose children are importable top-level names.
 *
 * - The directory of each `pyproject.toml`, `setup.py` or `setup.cfg`, plus its `src/`
 *   and any package directory the file names, is a root for the whole repo.
 * - The parent of a top-level package is a root for its own tree, or for the whole
 *   repo when no configuration exists. Under a test directory it serves that test
 *   directory alone.
 * - A file's own directory is a root for that file when it is not inside a package, as
 *   for a script. With no configuration the directories above it count too.
 *
 * Relative imports never consult any of this.
 */
import { basename, dirname, posix } from "node:path";
import { relPosix } from "../util/paths.js";
import { readFileInside } from "../util/safe-fs.js";

const CONFIG_FILES = new Set(["pyproject.toml", "setup.py", "setup.cfg"]);
const TEST_DIR = /^(tests?|testing)$/;

/** Directories a Python config file names as holding importable packages. */
function namedDirs(file: string, text: string): string[] {
  const out: string[] = [];
  const add = (dir: string) => out.push(dir);
  const strings = (list: string) => [...list.matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);
  if (file === "pyproject.toml") {
    for (const m of text.matchAll(/^\s*(where|pythonpath)\s*=\s*(\[[^\]]*\]|"[^"]*"|'[^']*')/gm)) strings(m[2]).forEach(add);
    // Hatch names packages by path, Poetry by `from`; setuptools maps "" to a directory.
    for (const m of text.matchAll(/^\s*packages\s*=\s*\[([^\]]*)\]/gm)) {
      for (const s of strings(m[1])) if (s.includes("/")) add(posix.dirname(s));
    }
    for (const m of text.matchAll(/\bfrom\s*=\s*["']([^"']+)["']/g)) add(m[1]);
    for (const m of text.matchAll(/^\s*python-source\s*=\s*["']([^"']+)["']/gm)) add(m[1]);
    for (const m of text.matchAll(/^\s*(?:""|'')\s*=\s*["']([^"']+)["']/gm)) add(m[1]);
    for (const m of text.matchAll(/package-dir\s*=\s*\{[^}]*(?:""|'')\s*=\s*["']([^"']+)["']/g)) add(m[1]);
  } else if (file === "setup.cfg") {
    for (const m of text.matchAll(/^\s*package_dir\s*=\s*(?:\r?\n\s*)?=\s*(\S+)/gm)) add(m[1]);
    for (const m of text.matchAll(/^\s*where\s*=\s*(\S+)/gm)) add(m[1]);
  } else {
    for (const m of text.matchAll(/package_dir\s*=\s*\{\s*(?:""|'')\s*:\s*["']([^"']+)["']/g)) add(m[1]);
    for (const m of text.matchAll(/find(?:_namespace)?_packages\(\s*(?:where\s*=\s*)?["']([^"']+)["']/g)) add(m[1]);
  }
  return out;
}

/** The roots a repo's Python configuration states, as repo-relative posix directories
 * ("" is the repo root). Empty when the repo has no such file. Unreadable files and
 * paths leaving their directory are skipped. */
export function readPythonRoots(root: string, repoFiles: string[]): string[] {
  const roots = new Set<string>();
  for (const f of repoFiles) {
    const name = basename(f);
    if (!CONFIG_FILES.has(name)) continue;
    const dir = relPosix(root, dirname(f));
    const at = (sub: string) => posix.normalize(posix.join(dir, sub)).replace(/\/$/, "").replace(/^\.$/, "");
    roots.add(dir).add(at("src"));
    let text: string | null = null;
    try {
      text = readFileInside(root, f);
    } catch {
      /* a link out of the repo or an unreadable file states nothing */
    }
    for (const sub of text ? namedDirs(name, text) : []) {
      const target = at(sub);
      if (!target.startsWith("..") && !posix.isAbsolute(target)) roots.add(target);
    }
  }
  return [...roots];
}

/** Where an import leads: a file, a directory with no `__init__.py` (written `dir/`),
 * nothing in the repo, or several roots with nothing to choose between them. */
export type PythonModule = string | "external" | "ambiguous";

const under = (dir: string, file: string): boolean => dir === "" || file.startsWith(`${dir}/`);

export class PythonModules {
  private readonly files: Set<string>;
  private readonly dirs = new Set<string>();
  private readonly packages = new Set<string>();
  private readonly roots: { dir: string; scope: string }[];
  private readonly configured: boolean;

  constructor(files: Iterable<string>, configRoots: readonly string[] = []) {
    this.files = new Set(files);
    this.configured = configRoots.length > 0;
    for (const f of this.files) {
      if (f.endsWith("/__init__.py")) this.packages.add(posix.dirname(f));
      for (let d = posix.dirname(f); d !== "."; d = posix.dirname(d)) this.dirs.add(d);
    }
    const seen = new Map<string, string>(configRoots.map((dir) => [dir, ""]));
    seen.set("", "");
    for (const pkg of this.packages) {
      const parent = posix.dirname(pkg) === "." ? "" : posix.dirname(pkg);
      if (this.packages.has(parent) || seen.has(parent)) continue;
      seen.set(parent, this.configured ? this.implicitScope(parent) : "");
    }
    // Deepest first, so the root nearest an importer is tried first.
    this.roots = [...seen].map(([dir, scope]) => ({ dir, scope })).sort((a, b) => b.dir.length - a.dir.length);
  }

  /** The tree a package's parent serves when configuration does not name it. */
  private implicitScope(dir: string): string {
    const parts = dir.split("/");
    const test = parts.findIndex((p) => TEST_DIR.test(p));
    return test >= 0 ? parts.slice(0, test + 1).join("/") : dir;
  }

  /** A module at this path: the package before the module file, as Python's finder has
   * it, and a bare directory as a namespace package. */
  at(path: string): string | null {
    for (const c of [`${path}/__init__.py`, `${path}.py`]) if (this.files.has(c)) return c;
    return this.dirs.has(path) ? `${path}/` : null;
  }

  /** The named submodule of a package file or namespace directory, if it has one. */
  submodule(module: string, name: string): string | null {
    const dir = module.endsWith("/") ? module.slice(0, -1) : module.endsWith("/__init__.py") ? posix.dirname(module) : null;
    return dir === null ? null : this.at(`${dir}/${name}`);
  }

  isModule(module: string): boolean {
    return this.files.has(module) || module.endsWith("/");
  }

  /** Resolve `spec` as written in `file`. */
  resolve(spec: string, file: string): PythonModule {
    if (spec.startsWith(".")) {
      const dots = /^\.+/.exec(spec)![0].length;
      const tail = spec.slice(dots).replace(/\./g, "/");
      // One dot = the importing file's own package, so the first dot costs no climb.
      const anchor = posix.normalize(posix.join(posix.dirname(file), ...Array(dots - 1).fill("..")));
      return this.at(tail ? posix.join(anchor, tail) : anchor) ?? "external";
    }
    return this.resolveAbsolute(spec.replace(/\./g, "/"), file);
  }

  private resolveAbsolute(module: string, file: string): PythonModule {
    const inRoot = (dir: string): string | null => {
      const hit = this.at(dir ? `${dir}/${module}` : module);
      return hit === file ? null : hit; // a module does not import itself by its own name
    };
    const usable = this.roots.filter((r) => under(r.scope, file));
    let namespace: string | null = null;
    // The roots above the importer, nearest first.
    for (const r of usable) {
      if (!under(r.dir, file)) continue;
      const hit = inRoot(r.dir);
      if (hit && !hit.endsWith("/")) return hit;
      namespace ??= hit;
    }
    // Any other root the importer can see, which must agree.
    const others = new Set(usable.filter((r) => !under(r.dir, file)).map((r) => inRoot(r.dir)).filter((h): h is string => !!h));
    const regular = [...others].filter((h) => !h.endsWith("/"));
    if (regular.length === 1) return regular[0];
    if (regular.length > 1) return "ambiguous";
    // The importer's own directory, when it is a script rather than part of a package.
    for (const dir of this.localDirs(file)) {
      const hit = inRoot(dir);
      if (hit && !hit.endsWith("/")) return hit;
      namespace ??= hit;
    }
    if (namespace) return namespace;
    return others.size === 1 ? [...others][0] : others.size > 1 ? "ambiguous" : "external";
  }

  private localDirs(file: string): string[] {
    const own = posix.dirname(file);
    if (own === "." || this.packages.has(own)) return [];
    const out: string[] = [];
    let test = false;
    for (let d = own; d !== "."; d = posix.dirname(d)) {
      // Configured repos keep this to a script's own folder and its test tree.
      if (this.configured && d !== own && !test) break;
      out.push(d);
      test = this.configured && own.split("/").slice(0, d.split("/").length - 1).some((p) => TEST_DIR.test(p));
    }
    return out;
  }
}
