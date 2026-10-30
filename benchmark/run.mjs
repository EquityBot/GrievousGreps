#!/usr/bin/env node
// Builds a graph of each pinned repository with the given tool, asks it for the
// callers of each symbol and prints recall against benchmark/truth.
//
//   node benchmark/run.mjs --tool dist/bin/graft.js [--baseline <upstream build>]
//                          [--repos httpx,click] [--work <dir>] [--verbose]
//
// It only builds and queries. Never run the tool's own test suite from here.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { constants, setPriority, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { detailTable, overallLine, recallTable, scoreSymbol, summarise } from './score.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MINUTE = 60_000;

function fail(message) {
  console.error(`benchmark: ${message}`);
  process.exit(1);
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) fail(`git ${args.join(' ')} failed: ${result.stderr || result.error}`);
  return result.stdout.trim();
}

// One shallow fetch of the pinned commit. Line endings stay as committed, so the
// truth's line numbers and the checkout agree on every platform.
function fetchRepo(repo, work) {
  const dir = join(work, 'repos', repo.name);
  if (!existsSync(join(dir, '.git'))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    git(['init', '--quiet'], dir);
    git(['config', 'core.autocrlf', 'false'], dir);
    git(['config', 'core.longpaths', 'true'], dir);
    git(['fetch', '--quiet', '--depth', '1', `https://github.com/${repo.repository}`, repo.sha], dir);
    git(['checkout', '--quiet', '--detach', 'FETCH_HEAD'], dir);
  }
  const head = git(['rev-parse', 'HEAD'], dir);
  if (head !== repo.sha) fail(`${repo.name} is at ${head}, expected ${repo.sha}. Delete ${dir} and rerun.`);
  return dir;
}

function runTool(tool, args, env, cwd, timeout) {
  const result = spawnSync(process.execPath, [tool, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    timeout,
  });
  if (result.error) fail(`${args.join(' ')}: ${result.error.message}`);
  return result;
}

function parseResult(stdout) {
  const start = stdout.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return null;
  }
}

// How hard can it be? 'Ambitious but rubbish' is the result this table exists to catch.
function scoreRepo(repo, source, tool, label, work, verbose) {
  const truth = JSON.parse(readFileSync(join(HERE, 'truth', `${repo.name}.json`), 'utf8'));
  const copy = join(work, 'run', label, repo.name);
  rmSync(copy, { recursive: true, force: true });
  cpSync(source, copy, { recursive: true, verbatimSymlinks: true });

  // The scratch home keeps the run away from your graphs, agent settings and hooks
  // whatever the tool does, and the dotenv path keeps it away from any .env file.
  const home = join(work, 'home', label);
  const env = {
    ...process.env,
    TRAIL_HOME: join(home, '.trail'),
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
    CODEX_HOME: join(home, '.codex'),
    DOTENV_CONFIG_PATH: join(work, 'no-such.env'),
    DO_NOT_TRACK: '1',
    TRAIL_CLOUD: '0',
    GRAFT_NO_GITIGNORE: '1',
    GRAFT_NO_IGNORE: '1',
    GRAFT_NO_TRAIL_SWITCH: '1',
  };
  mkdirSync(env.TRAIL_HOME, { recursive: true });

  const build = runTool(tool, ['build', copy, '--no-gitignore', '--no-ignore'], env, work, 45 * MINUTE);
  if (build.status !== 0) fail(`${label} could not build ${repo.name}:\n${build.stdout}\n${build.stderr}`);

  const scores = [];
  let unreadable = 0;
  for (const [symbol, symbolTruth] of Object.entries(truth)) {
    const asJson = runTool(tool, ['callers', symbol, copy, '--json'], env, work, 10 * MINUTE);
    const plain = runTool(tool, ['callers', symbol, copy], env, work, 10 * MINUTE);
    const result = parseResult(asJson.stdout);
    if (result === null) {
      unreadable += 1;
      console.error(`benchmark: ${label} ${repo.name} ${symbol}: no JSON in the output (exit ${asJson.status})`);
    }
    const score = scoreSymbol(symbolTruth, result ?? {}, plain.stdout + plain.stderr, repo.rules);
    scores.push(score);
    if (verbose) {
      const misses = score.missed.map((row) => `${row.file}:${row.chain}`).slice(0, 10);
      console.error(`${label} ${repo.name} ${symbol}: ${score.found}/${score.required} ${score.undercount} ${misses.join(' ')}`);
    }
  }
  // A broken tool must not pass as a recall of 0.00.
  if (unreadable === scores.length) fail(`${label} returned no readable answer for any symbol in ${repo.name}.`);
  rmSync(copy, { recursive: true, force: true });
  return summarise(scores);
}

function toolVersion(tool, work) {
  const result = spawnSync(process.execPath, [tool, '--version'], { cwd: work, encoding: 'utf8' });
  return result.stdout.trim().split('\n').at(-1) || 'unknown';
}

const { values } = parseArgs({
  options: {
    tool: { type: 'string' },
    baseline: { type: 'string' },
    repos: { type: 'string' },
    work: { type: 'string' },
    verbose: { type: 'boolean', default: false },
  },
});
if (!values.tool) fail('--tool <path to dist/bin/graft.js> is required.');

const absolute = (path) => (isAbsolute(path) ? path : resolve(path));
const tool = absolute(values.tool);
const baseline = values.baseline && absolute(values.baseline);
for (const path of [tool, baseline]) if (path && !existsSync(path)) fail(`${path} does not exist.`);

const allRepos = JSON.parse(readFileSync(join(HERE, 'repos.json'), 'utf8'));
const wanted = values.repos?.split(',');
const unknown = wanted?.filter((name) => !allRepos.some((repo) => repo.name === name)) ?? [];
if (unknown.length > 0) fail(`unknown repositories: ${unknown.join(', ')}`);
const repos = wanted ? allRepos.filter((repo) => wanted.includes(repo.name)) : allRepos;

const work = absolute(values.work ?? join(tmpdir(), 'grievousgreps-benchmark'));
mkdirSync(work, { recursive: true });

// Modest by design: one repository at a time, below normal priority.
try {
  setPriority(constants.priority.PRIORITY_BELOW_NORMAL);
} catch {
  // Priority is a courtesy, so a platform that refuses it changes nothing.
}

const upstream = baseline ? {} : null;
const patched = {};
for (const repo of repos) {
  const source = fetchRepo(repo, work);
  if (upstream) upstream[repo.name] = scoreRepo(repo, source, baseline, 'upstream', work, values.verbose);
  patched[repo.name] = scoreRepo(repo, source, tool, 'patched', work, values.verbose);
}

console.log(`Node ${process.version}, ${new Date().toISOString().slice(0, 10)} UTC`);
if (baseline) console.log(`Upstream: ${baseline} (${toolVersion(baseline, work)})`);
console.log(`Patched: ${tool} (${toolVersion(tool, work)})\n`);
console.log(overallLine(upstream && Object.values(upstream), Object.values(patched)));
console.log();
console.log(recallTable(repos, upstream, patched));
console.log();
if (upstream) console.log(`${detailTable(repos, 'Upstream', upstream)}\n`);
console.log(detailTable(repos, 'Patched', patched));
