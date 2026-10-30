/**
 * `graft version` / `graft --version` support, and the refusal `graft upgrade` prints.
 *
 * Split out of cli.ts so the formatting helpers can be unit-tested with
 * injected results instead of hitting the network from tests.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brand, PACKAGE_FOR } from "./brand.js";

/** Locates package.json relative to a module URL (works for both `dist/cli.js`
 * running one level under the published package root, and `src/cli.ts` running
 * one level under the repo root via tsx). */
export function resolvePackageJsonPath(moduleUrl: string): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const candidates = [resolve(moduleDir, "..", "package.json"), resolve(moduleDir, "package.json")];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return candidates[0];
}

/**
 * The npm package this code was installed as. Update checks go to the package
 * actually installed, not to the name typed.
 */
export function readPackageName(moduleUrl: string): string {
  try {
    const pkg = JSON.parse(readFileSync(resolvePackageJsonPath(moduleUrl), "utf8")) as { name?: string };
    return pkg.name ?? PACKAGE_FOR.graft;
  } catch {
    return PACKAGE_FOR.graft;
  }
}

const PKG_NAME = readPackageName(import.meta.url);

/** Reads the version of the graft package this module was loaded from. */
export function readCurrentVersion(moduleUrl: string): string {
  const raw = readFileSync(resolvePackageJsonPath(moduleUrl), "utf8");
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? "0.0.0";
}

/** Runs `npm <args>`. On Windows `npm` is the `npm.cmd` shim, which only a shell
 * can start: spawned directly it fails with ENOENT, so the update check stored nothing.
 * The shell gets one joined command line because Node 24 warns (DEP0190) when it
 * has to join args for a shell. Every arg here is a fixed token, never user input,
 * and `npm` is found on PATH exactly as when the user runs it. */
function npmSync(args: readonly string[], options: SpawnSyncOptions) {
  const win = process.platform === "win32";
  // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true -- fixed npm tokens only
  return spawnSync(win ? ["npm", ...args].join(" ") : "npm", win ? [] : args, { ...options, shell: win }); // NOSONAR: npm from PATH is intended
}

export interface NpmViewResult {
  ok: boolean;
  version?: string;
}

/** `npm view <pkg> version`, offline-safe: any failure (no npm, no network,
 * timeout) resolves to `{ ok: false }` rather than throwing. */
export function getNpmViewVersion(pkgName: string = PKG_NAME, timeoutMs = 2000): NpmViewResult {
  try {
    const res = npmSync(["view", pkgName, "version"], {
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
    });
    if (res.error || res.signal || res.status !== 0) return { ok: false };
    const version = res.stdout?.toString().trim();
    if (!version) return { ok: false };
    return { ok: true, version };
  } catch {
    return { ok: false };
  }
}

/** Pure formatter for `graft version`. No package is published under this distribution, so nothing is compared. */
export function formatVersionReport(current: string): string {
  return `${brand()} ${current}\nnot compared with npm: this distribution has no published package`;
}

/** `upgrade` on this fork: no package is published under it, and npm's would replace it. */
export const UPGRADE_UNAVAILABLE =
  "✗ upgrade is not available for this distribution: the package on npm is upstream's, and installing it would replace this one. See the install instructions in this repository's README.";
