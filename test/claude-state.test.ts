import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyStats, readStats, writeStats, patchStats,
  readSession, writeSession, acquireLock, releaseLock, cacheDir, LOCK_STALE_MS, writeJsonAtomic,
} from '../src/claude/state.js';
import { runSync } from '../src/claude/sync-run.js';
import { LOCK_MAX_MS, lockHeldIn } from '../src/util/state.js';

function fresh(): string { return mkdtempSync(join(tmpdir(), 'graft-state-')); }

test('stats round-trip and patch merge', () => {
  const d = fresh();
  assert.equal(readStats(d), null);
  writeStats(d, { ...emptyStats(), nodeCount: 319, edgeCount: 730 });
  assert.equal(readStats(d)!.nodeCount, 319);
  const patched = patchStats(d, { dirty: true, staleCount: 4 });
  assert.equal(patched.dirty, true);
  assert.equal(patched.staleCount, 4);
  assert.equal(readStats(d)!.edgeCount, 730, 'patch preserves other fields');
});

test('session defaults and round-trip', () => {
  const d = fresh();
  const s = readSession(d, 'abc');
  assert.deepEqual(s, { graftReads: 0, sourceReads: 0, savedTokens: 0, injectedPointers: [], nudges: 0 });
  s.promptAsks = 1; s.graftReads = 2;
  writeSession(d, 'abc', s);
  assert.equal(readSession(d, 'abc').promptAsks, 1);
  assert.equal(readSession(d, 'abc').graftReads, 2);
  assert.equal(readSession(d, 'xyz').graftReads, 0, 'other sessions isolated');
});

test('lock is exclusive then releasable', () => {
  const d = fresh();
  assert.equal(acquireLock(d), true);
  assert.equal(acquireLock(d), false, 'second acquire blocked while held');
  assert.ok(existsSync(join(cacheDir(d), '.sync.lock')));
  releaseLock(d);
  assert.equal(acquireLock(d), true, 'reacquire after release');
});

/** A lock file holding `body`, last written `ageMs` ago. */
function lockFile(d: string, body: string, ageMs: number): string {
  mkdirSync(cacheDir(d), { recursive: true });
  const p = join(cacheDir(d), '.sync.lock');
  writeFileSync(p, body);
  const t = (Date.now() - ageMs) / 1000;
  utimesSync(p, t, t);
  return p;
}
const lockOf = (d: string, pid: number, ageMs: number): string =>
  lockFile(d, JSON.stringify({ pid, at: new Date().toISOString() }), ageMs);
/** The pid of a process that has already exited. */
function deadPid(): number { return spawnSync(process.execPath, ['-e', '']).pid!; }

test('acquireLock reclaims a stale lock whose owner has gone', () => {
  const d = fresh();
  lockOf(d, deadPid(), LOCK_STALE_MS + 1000);
  assert.equal(lockHeldIn(cacheDir(d)), false);
  assert.equal(acquireLock(d), true, 'stale lock reclaimed');
});

test('a young lock stays held even with its owner gone', () => {
  // The owner has usually gone by now: the query or hook that took the lock exits as
  // soon as it has started sync-run, which claims the lock a moment later.
  const d = fresh();
  lockOf(d, deadPid(), 1000);
  assert.equal(lockHeldIn(cacheDir(d)), true);
  assert.equal(acquireLock(d), false);
});

test('a lock past LOCK_STALE_MS stays with an owner that is still running', () => {
  // Age alone took the lock from a first build still running, and the next query started
  // a second full build beside it.
  const d = fresh();
  lockOf(d, process.pid, LOCK_STALE_MS + 1000);
  assert.equal(lockHeldIn(cacheDir(d)), true);
  assert.equal(acquireLock(d), false, 'the running build keeps its lock');
});

test('past LOCK_MAX_MS a lock is reclaimed even with a live pid', () => {
  // That pid may be a new process that got a dead owner's number.
  const d = fresh();
  lockOf(d, process.pid, LOCK_MAX_MS + 1000);
  assert.equal(lockHeldIn(cacheDir(d)), false);
  assert.equal(acquireLock(d), true);
});

test('a stale lock that names no usable pid is reclaimed by age', () => {
  for (const body of ['not json', '{}', '{"pid":"1"}', '{"pid":0}', '{"pid":-1}', '{"pid":1.5}']) {
    const d = fresh();
    lockFile(d, body, LOCK_STALE_MS + 1000);
    assert.equal(acquireLock(d), true, body);
  }
});

test('runSync names itself in the lock it was handed', () => {
  // The hook or query that took the lock exits at once, so the lock must name the process
  // doing the build, or it reads as abandoned while the build runs.
  const d = fresh();
  const p = lockOf(d, deadPid(), 0);
  let owner: unknown;
  runSync(d, () => { owner = JSON.parse(readFileSync(p, 'utf8')).pid; });
  assert.equal(owner, process.pid);
  assert.equal(existsSync(p), false, 'released when the build ends');
});

test('writeJsonAtomic leaves no scratch file behind when the write fails', () => {
  const d = fresh();
  const dir = join(d, 'locked');
  mkdirSync(dir, { recursive: true });

  // The failure is injected by putting a *directory* where the file belongs, so the
  // rename fails. This replaces a read-only parent dir (`chmod 0o500`), which was
  // both non-portable — Windows ignores it, and so does root, hence the skip this
  // test used to carry — and weaker: the tmp file was never created there, so there
  // was never anything that could have been left behind. Here it definitely is.
  const target = join(dir, 'out.json');
  mkdirSync(target);

  // Every CLI invocation is a new pid, so a repeatedly failing write would leave one
  // full-size `<path>.<pid>.tmp` per attempt, and nothing in graft ever lists these
  // directories to clean them up — on a nearly-full disk that accelerates the ENOSPC
  // that caused it.
  assert.throws(() => writeJsonAtomic(target, { pad: 'x'.repeat(1024) }));
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.endsWith('.tmp')),
    [],
    'no .tmp residue',
  );
});
