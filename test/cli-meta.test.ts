import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { delimiter, join, resolve } from 'node:path';
import {
  formatVersionReport,
  resolvePackageJsonPath,
  readCurrentVersion,
  getNpmViewVersion,
} from '../src/cli-meta.js';

// --- formatVersionReport: this distribution has nothing published to compare with ---

test('formatVersionReport: the local version, said not to be compared', () => {
  assert.equal(formatVersionReport('0.28.0+gg'), 'graft 0.28.0+gg\nnot compared with npm: this distribution has no published package');
});

// --- resolvePackageJsonPath / readCurrentVersion: real filesystem, no network ---

test('resolvePackageJsonPath finds package.json one level above a dist/cli.js-shaped module path', () => {
  const fakeDistCli = pathToFileURL(resolve(process.cwd(), 'dist/cli.js')).href;
  const found = resolvePackageJsonPath(fakeDistCli);
  assert.equal(found, resolve(process.cwd(), 'package.json'));
});

test('resolvePackageJsonPath finds package.json one level above a src/cli.ts-shaped module path', () => {
  const fakeSrcCli = pathToFileURL(resolve(process.cwd(), 'src/cli.ts')).href;
  const found = resolvePackageJsonPath(fakeSrcCli);
  assert.equal(found, resolve(process.cwd(), 'package.json'));
});

test('readCurrentVersion reads the real package.json version', () => {
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'));
  const v = readCurrentVersion(pathToFileURL(resolve(process.cwd(), 'src/cli.ts')).href);
  assert.equal(v, pkg.version);
});

// --- npm launch: a fake npm first on PATH stands in for the real one ---
//
// On Windows `npm` is the `npm.cmd` shim, which spawnSync cannot start without a
// shell: the update check stored nothing. Ported from ansidium/trail-code-se7en
// (4fa301e664a8, MIT).

function withFakeNpm(fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'graft-fake-npm-'));
  const script = [
    'const args = process.argv.slice(2);',
    "if (args[0] === 'view') console.log('9.9.9');",
  ];
  writeFileSync(join(dir, 'fake-npm.cjs'), script.join('\n'));
  if (process.platform === 'win32') {
    writeFileSync(join(dir, 'npm.cmd'), `@"${process.execPath}" "%~dp0fake-npm.cjs" %*\r\n`);
  } else {
    writeFileSync(join(dir, 'npm'), `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-npm.cjs" "$@"\n`);
    chmodSync(join(dir, 'npm'), 0o755);
  }
  const path = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${path}`;
  try {
    fn();
  } finally {
    process.env.PATH = path;
    rmSync(dir, { recursive: true, force: true });
  }
}

test('getNpmViewVersion reads the latest version from npm on PATH', () => {
  withFakeNpm(() => {
    assert.deepEqual(getNpmViewVersion('@equitybot/grievousgreps', 30_000), { ok: true, version: '9.9.9' });
  });
});
