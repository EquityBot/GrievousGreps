/**
 * `trail docs` / `graft docs`: ranked search over a repository's Markdown and
 * text, answered by the gg-docs binary built from `rust/gg-docs`.
 *
 * This module finds the binary and runs it. Text answers pass through
 * untouched, so the binary's formatter is the only one. A `--json` answer is
 * one object whose `protocol` must equal {@link DOCS_PROTOCOL}, and every call
 * passes `--protocol` too, so a binary speaking another version refuses before
 * it reads anything. Nothing here touches the network: the binary is the one
 * TRAIL_DOCS_BIN names, a prebuilt copy in the checkout or a local cargo build.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { brand, tag } from "../brand.js";
import { checkoutRoot } from "../notes/home.js";

/** The `--json` protocol this CLI reads; gg-docs bumps it on any incompatible change. */
export const DOCS_PROTOCOL = 1;

/** The prebuilt target for a platform. Other platforms build gg-docs from source. */
export function docsTarget(platform: string = process.platform, arch: string = process.arch): string | undefined {
  if (arch !== "x64") return undefined;
  if (platform === "win32") return "x86_64-pc-windows-msvc";
  if (platform === "linux") return "x86_64-unknown-linux-musl";
  return undefined;
}

/** `rust/gg-docs/VERSION`, when it holds one plain version: it becomes part of a path. */
function crateVersion(crate: string): string | undefined {
  try {
    const version = readFileSync(join(crate, "VERSION"), "utf8").trim();
    return /^\d+\.\d+\.\d+$/.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The gg-docs binary for this checkout, first match wins: TRAIL_DOCS_BIN; a
 * prebuilt copy at `rust/gg-docs/prebuilt/<VERSION>/<target>/`, so a pull that
 * changes VERSION stops using the old one; a `cargo build --release` in the
 * crate. Otherwise what to do about it.
 */
export function findDocsBinary(
  pkgRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
  arch: string = process.arch,
): { bin: string } | { error: string } {
  const named = env.TRAIL_DOCS_BIN;
  if (named) {
    return existsSync(named) ? { bin: resolve(named) } : { error: `✗ TRAIL_DOCS_BIN names no file: ${named}` };
  }
  const exe = platform === "win32" ? "gg-docs.exe" : "gg-docs";
  const crate = join(pkgRoot, "rust", "gg-docs");
  const target = docsTarget(platform, arch);
  const version = crateVersion(crate);
  const prebuilt = target && version ? join(crate, "prebuilt", version, target, exe) : undefined;
  const built = join(crate, "target", "release", exe);
  for (const bin of [prebuilt, built]) if (bin && existsSync(bin)) return { bin };
  const lines = [
    `✗ ${brand()} docs needs the gg-docs binary, and none was found at:`,
    ...[prebuilt, built].filter((p) => p !== undefined).map((p) => `    ${p}`),
    `  Build it (needs a Rust toolchain): cargo build --release --locked --manifest-path ${join(crate, "Cargo.toml")}`,
  ];
  if (prebuilt) lines.push(`  Or put a gg-docs ${version} binary for ${target} at the first path above.`);
  lines.push("  Or set TRAIL_DOCS_BIN to a gg-docs binary.");
  return { error: lines.join("\n") };
}

/**
 * The folder to search: the one named, else the enclosing git checkout, else
 * here. Either is refused when it is the home folder or a drive's root (a
 * dotfiles checkout can be either), where the index would take in everything
 * beneath it; `--root` still allows it.
 */
export function docsRoot(
  named: string | undefined,
  cwd: string = process.cwd(),
  home: string = homedir(),
): { root: string; note?: string } | { error: string } {
  if (named !== undefined) return { root: resolve(named) };
  const here = resolve(cwd);
  const repo = checkoutRoot(here);
  const root = repo ?? here;
  if (root === resolve(home) || dirname(root) === root) {
    return { error: `✗ ${root} is the home folder or a drive's root, and searching it would index everything under it.\n  cd into a repository, or name the folder with --root.` };
  }
  if (repo !== null && repo !== here) return { root, note: `${tag()} docs: searching the whole checkout at ${repo}` };
  return { root };
}

/** Why a `--json` answer cannot be trusted, or undefined when it can. */
export function envelopeProblem(stdout: string): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return "✗ gg-docs did not answer with JSON";
  }
  const protocol = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as { protocol?: unknown }).protocol : undefined;
  if (protocol === DOCS_PROTOCOL) return undefined;
  return `✗ gg-docs answered in protocol ${protocol === undefined ? "(none)" : String(protocol)}, but ${brand()} reads protocol ${DOCS_PROTOCOL}: install the gg-docs that matches this checkout`;
}

export type DocsCommand =
  | { sub: "search"; query: string[]; limit?: string; json?: boolean }
  | { sub: "get"; path: string; from?: string; lines?: string }
  | { sub: "status" | "update"; json?: boolean };

/** The binary's arguments. Words and paths go after `--`, so one starting with `-` stays a word. */
export function docsArgs(c: DocsCommand, root: string): string[] {
  const head = ["--protocol", String(DOCS_PROTOCOL), "--root", root, c.sub];
  switch (c.sub) {
    case "search":
      return [...head, ...(c.limit ? ["-n", c.limit] : []), ...(c.json ? ["--json"] : []), "--", ...c.query];
    case "get":
      return [...head, ...(c.from ? ["--from", c.from] : []), ...(c.lines ? ["--lines", c.lines] : []), "--", c.path];
    default:
      return [...head, ...(c.json ? ["--json"] : [])];
  }
}

/** The first count option that is not a positive whole number, as an error line. */
function badCount(c: DocsCommand): string | undefined {
  const counts: [string, string | undefined][] =
    c.sub === "search" ? [["--limit", c.limit]] : c.sub === "get" ? [["--from", c.from], ["--lines", c.lines]] : [];
  for (const [flag, value] of counts) {
    if (value !== undefined && !/^[1-9]\d*$/.test(value)) return `✗ ${flag} must be a positive whole number, got "${value}"`;
  }
  return undefined;
}

/** Runs one docs command and returns the exit code: the binary's own, or 1 when it could not answer. */
export function runDocs(c: DocsCommand, opts: { root?: string; pkgRoot: string }): number {
  const bad = badCount(c);
  if (bad) {
    console.error(bad);
    return 1;
  }
  const found = findDocsBinary(opts.pkgRoot);
  if ("error" in found) {
    console.error(found.error);
    return 1;
  }
  const place = docsRoot(opts.root);
  if ("error" in place) {
    console.error(place.error);
    return 1;
  }
  const { root, note } = place;
  if (note) console.error(note);
  const json = c.sub !== "get" && c.json === true;
  const result = spawnSync(found.bin, docsArgs(c, root), {
    stdio: ["ignore", json ? "pipe" : "inherit", "inherit"],
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) {
    console.error(`✗ could not run ${found.bin}: ${result.error.message}`);
    return 1;
  }
  if (result.status !== 0) return result.status ?? 1;
  if (!json) return 0;
  const problem = envelopeProblem(result.stdout.toString("utf8"));
  if (problem) {
    console.error(problem);
    return 1;
  }
  process.stdout.write(result.stdout);
  return 0;
}
