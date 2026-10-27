/**
 * Filesystem access confined to a trusted base directory.
 *
 * graft writes its output under `<repo>/graft/`, appends to `<repo>/.gitignore`
 * and `.ignore`, edits instruction files, and inlines source spans — and a
 * repository (or a pull request the GitHub App checks out) can commit any of those
 * paths, or a directory above them, as a symlink. Following one would let committed
 * content redirect a read, write or delete to anywhere the running user can reach.
 *
 * Every such path goes through {@link resolveInside}: it resolves the path against a
 * base WITHOUT following any symlink below that base, and refuses anything that
 * lands outside it. The base itself is trusted — the repo root, or the parent of
 * the context dir so the `graft/` component itself is checked too.
 *
 * shortcut: the checks run before the operation, not through `openat`/`O_NOFOLLOW`
 * on each component (Node exposes neither portably). That defeats links already in
 * the tree — the committed-content threat — but not a local process swapping a
 * component between check and use. Closing that needs a native fd-relative walk.
 */
/* eslint-disable security/detect-non-literal-fs-filename -- this module is the path
   validator: every path it hands to fs is the one being checked, or one it built. */
import { type BigIntStats, constants, copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Resolve `target` (absolute, or relative to `base`) and prove it stays inside
 * `base` through real directories: no `..` or absolute escape, and no existing
 * component below `base` — the leaf included — is a symlink (or, above the leaf,
 * anything but a directory). Components that do not exist yet are fine: there is
 * nothing to follow. Throws on a violation; returns the absolute path.
 */
export function resolveInside(base: string, target: string): string {
  const root = resolve(base);
  const abs = resolve(root, target);
  const rel = relative(root, abs);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`refusing a path outside ${root}: ${target}`);
  }
  const parts = rel === "" ? [] : rel.split(sep);
  let cur = root;
  for (const [i, part] of parts.entries()) {
    cur = join(cur, part);
    let st;
    try {
      st = lstatSync(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") break; // nothing below exists either
      throw e;
    }
    if (st.isSymbolicLink()) throw new Error(`refusing to follow a symlink: ${cur}`);
    if (i < parts.length - 1 && !st.isDirectory()) throw new Error(`refusing a non-directory: ${cur}`);
  }
  return abs;
}

/**
 * The trusted base for a directory graft keeps under a repo `root`: `root` itself
 * when `dir` sits inside it, so every repository-controlled component between them
 * is checked (the default `graft/`, or a relative `--dir`/`GRAFT_DIR`), else `dir`'s
 * own parent, which the operator chose.
 *
 * A `dir` spelled through another name for the repository (different case on a
 * case-insensitive volume, a linked ancestor such as macOS `/tmp`, or a link to
 * the root or a directory under it) is still inside. The base is then the shortest
 * prefix of `dir`, in its own spelling, that resolves into the repository: that
 * prefix is an entry outside the repository, which the operator controls, and
 * every component below it is a repository entry the checks walk.
 */
export function trustedBaseFor(root: string, dir: string): string {
  const rel = relative(resolve(root), resolve(dir));
  const inside = rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  if (inside) return root;
  const id = statSync(root, { bigint: true, throwIfNoEntry: false });
  if (id && id.ino !== 0n) {
    // Every prefix down from the filesystem root, which can itself be an alias (a
    // subst drive, a mount point).
    const prefixes: string[] = [];
    for (let cur = dirname(resolve(dir)); ; cur = dirname(cur)) {
      prefixes.unshift(cur);
      if (dirname(cur) === cur) break;
    }
    for (const prefix of prefixes) {
      let real: string;
      try {
        real = realpathSync.native(prefix);
      } catch {
        break; // nothing below a missing prefix exists to follow
      }
      if (isSameOrUnder(real, id)) return prefix;
    }
  }
  return dirname(dir);
}

/** Whether the real path `real`, or one of its ancestors, is the directory `id`
 * names; compared by device and inode, so case and aliases do not matter. */
function isSameOrUnder(real: string, id: BigIntStats): boolean {
  for (let cur = real, up = dirname(cur); ; cur = up, up = dirname(cur)) {
    const st = statSync(cur, { bigint: true, throwIfNoEntry: false });
    if (st && st.dev === id.dev && st.ino === id.ino) return true;
    if (cur === up) return false;
  }
}

/** {@link resolveInside} for a directory, creating whatever part of it is missing.
 * Every existing component was just proved a real directory, so the recursive
 * mkdir only ever creates real directories inside `base`. */
export function ensureDirInside(base: string, dir: string): string {
  const abs = resolveInside(base, dir);
  mkdirSync(abs, { recursive: true });
  return abs;
}

/**
 * Write `data` to `path`, which must sit inside `base` through real directories.
 * A symlink at the leaf is replaced, never written through: `atomic` renames a
 * fresh exclusive temp file over it, otherwise the link is unlinked first. The temp
 * name is unpredictable, so a committed `<name>.<pid>.tmp` link cannot catch it.
 */
export function writeFileInside(base: string, path: string, data: string | Uint8Array, opts: { atomic?: boolean } = {}): string {
  const abs = resolve(base, path);
  ensureDirInside(base, dirname(abs));
  if (opts.atomic) {
    replaceAtomically(abs, (tmp) => {
      writeFileSync(tmp, data, { flag: "wx" });
    });
    return abs;
  }
  if (isSymlink(abs)) rmSync(abs);
  writeFileSync(abs, data);
  return abs;
}

/** Copy `src` — which the caller has already validated — to `dest` inside `base`,
 * streamed into an exclusive temp file and renamed over the leaf like an atomic
 * {@link writeFileInside}, without holding the whole file in memory. */
export function copyFileInside(base: string, src: string, dest: string): string {
  const abs = resolve(base, dest);
  ensureDirInside(base, dirname(abs));
  replaceAtomically(abs, (tmp) => {
    copyFileSync(src, tmp, constants.COPYFILE_EXCL);
  });
  return abs;
}

/** Fill a fresh, unpredictably named sibling of `abs`, then rename it over `abs`:
 * the rename replaces a symlink leaf rather than following it. */
// eslint-disable-next-line no-unused-vars -- a parameter name inside a function type
function replaceAtomically(abs: string, fill: (tmp: string) => void): void {
  const tmp = `${abs}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fill(tmp);
    renameSync(tmp, abs);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing more we can do */ }
    throw e;
  }
}

/** The text of the regular file at `path` inside `base`, or null when there is none
 * there — a symlink leaf counts as none and is never read through. Throws, like
 * {@link resolveInside}, when the path escapes `base` or crosses a symlink above. */
export function readFileInside(base: string, path: string): string | null {
  const abs = resolve(base, path);
  resolveInside(base, dirname(abs));
  let st;
  try {
    st = lstatSync(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  return st.isFile() ? readFileSync(abs, "utf8") : null;
}

/** Delete the file at `path` inside `base`. A symlink leaf is removed itself
 * (`rm` never follows one); a symlinked directory above it is refused. */
export function removeFileInside(base: string, path: string): void {
  const abs = resolve(base, path);
  resolveInside(base, dirname(abs));
  rmSync(abs, { force: true });
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
