/**
 * The four gates. Each one is tested alone, because the value of the design is
 * that any single one of them is sufficient to stop everything.
 */
import { cloudEnabled } from "../src/cloud/workspace.js";
import { maybeRefreshInBackground } from "../src/upkeep.js";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { doNotTrack, explainOff, inCi, offReason, telemetryOn } from '../src/telemetry/gate.js';
import { track } from '../src/telemetry/track.js';
import { peek } from '../src/telemetry/queue.js';
import { tmpRepo } from './helpers.js';

const KEY = 'phc_test_key';

function home(tag: string, state?: Record<string, unknown>): string {
  const dir = tmpRepo(tag);
  mkdirSync(join(dir, '.graft'), { recursive: true });
  if (state) writeFileSync(join(dir, '.graft', 'telemetry.json'), JSON.stringify(state));
  return dir;
}

test('no key: a fork or a local build can never send, whatever the settings say', () => {
  const h = home('gate-nokey', { installId: 'x', enabled: true });
  delete process.env.GRAFT_POSTHOG_KEY;
  assert.equal(offReason(h, {}), 'no-key');
  assert.equal(track('first_run', {}, { home: h, env: {} }), null);
  assert.deepEqual(peek(h), []);
});

test('DO_NOT_TRACK outranks our own setting', () => {
  process.env.GRAFT_POSTHOG_KEY = KEY;
  const h = home('gate-dnt', { installId: 'x', enabled: true });
  assert.equal(offReason(h, { DO_NOT_TRACK: '1' }), 'do-not-track');
  assert.equal(track('first_run', {}, { home: h, env: { DO_NOT_TRACK: '1' } }), null);
});

test('DO_NOT_TRACK=0 and an empty value mean "not set"', () => {
  assert.equal(doNotTrack({ DO_NOT_TRACK: '0' }), false);
  assert.equal(doNotTrack({ DO_NOT_TRACK: '' }), false);
  assert.equal(doNotTrack({}), false);
  assert.equal(doNotTrack({ DO_NOT_TRACK: 'true' }), true);
});

test('CI is never counted as a user', () => {
  process.env.GRAFT_POSTHOG_KEY = KEY;
  const h = home('gate-ci', { installId: 'x' });
  assert.equal(offReason(h, { CI: 'true' }), 'ci');
  assert.equal(offReason(h, { GITHUB_ACTIONS: 'true' }), 'ci');
  assert.equal(inCi({ CI: 'false' }), false, 'CI=false is not CI');
  assert.equal(inCi({ CI: '0' }), false);
});

test('the user switch turns everything off', () => {
  process.env.GRAFT_POSTHOG_KEY = KEY;
  const h = home('gate-disabled', { installId: 'x', enabled: false });
  assert.equal(offReason(h, {}), 'disabled');
  assert.equal(track('query', { command: 'ask' }, { home: h, env: {} }), null);
  assert.deepEqual(peek(h), []);
});

test('all four open: the event is recorded', () => {
  process.env.GRAFT_POSTHOG_KEY = KEY;
  const h = home('gate-open', { installId: 'x', enabled: true });
  assert.equal(offReason(h, {}), null);
  assert.equal(telemetryOn(h, {}), true);
  assert.ok(track('query', { command: 'ask', surface: 'cli' }, { home: h, env: {} }));
  assert.equal(peek(h).length, 1);
});

test('never chosen means off — the documented default — until asked for', () => {
  process.env.GRAFT_POSTHOG_KEY = KEY;
  const h = home('gate-default', { installId: 'x' }); // no `enabled` field
  assert.equal(offReason(h, {}), 'disabled');
  assert.equal(offReason(h, { GRAFT_TELEMETRY: '1' }), null, 'the variable asks for it');
  const chosen = home('gate-chosen', { installId: 'x', enabled: true });
  assert.equal(offReason(chosen, {}), null, 'and so does the stored choice');
  const declined = home('gate-declined', { installId: 'x', enabled: false });
  assert.equal(offReason(declined, { GRAFT_TELEMETRY: '1' }), 'disabled', 'telemetry disable outranks the variable');
});

test('every reason has a sentence naming the switch that is closed', () => {
  for (const r of ['no-key', 'do-not-track', 'ci', 'disabled'] as const) {
    assert.match(explainOff(r), /^off: \S/);
  }
  assert.match(explainOff('do-not-track'), /DO_NOT_TRACK/);
  assert.match(explainOff('disabled'), /graft telemetry enable/);
});

test("nothing is on by default: telemetry, the workspace and the update check all need asking for", () => {
  const home = mkdtempSync(join(tmpdir(), "gate-default-"));
  const env = { GRAFT_POSTHOG_KEY: "k", HOME: home, USERPROFILE: home };
  const saved = { key: process.env.GRAFT_POSTHOG_KEY, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, env);
  try {
    assert.notEqual(offReason(home, env), null, "telemetry");
    assert.equal(cloudEnabled(env), false, "the workspace");
    assert.equal(maybeRefreshInBackground(home, Date.now(), env), false, "the update check");
    assert.equal(cloudEnabled({ ...env, TRAIL_CLOUD: "1" }), true, "asked for");
  } finally {
    for (const [k, v] of Object.entries({ GRAFT_POSTHOG_KEY: saved.key, HOME: saved.HOME, USERPROFILE: saved.USERPROFILE })) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
});
