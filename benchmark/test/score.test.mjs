import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { overallLine, pool, recallTable, satisfies, scoreSymbol, spanContains, summarise } from '../score.mjs';

const truth = {
  target: 'src/a.py',
  target_lines: [10],
  required: [
    { file: 'src/b.py', chain: 'caller', lines: [5] },
    { file: 'src/c.py', chain: '<file>', lines: [1] },
  ],
};
const definition = { path: 'src/a.py', span: 'L10-L20' };
const inCaller = { id: 'src/b.py#caller', path: 'src\\b.py', span: 'L4-L6' };
const inFile = { id: 'src/c.py', path: 'src/c.py' };

test('a span holds a line only inside its range', () => {
  assert.equal(spanContains('L4-L6', [5]), true);
  assert.equal(spanContains('L4-L6', [7]), false);
  assert.equal(spanContains(undefined, [5]), false);
});

test('a hit needs the file and the call line, or only the file for a module-level row', () => {
  assert.equal(satisfies(inCaller, truth.required[0]), true);
  assert.equal(satisfies({ ...inCaller, span: 'L7-L9' }, truth.required[0]), false);
  assert.equal(satisfies(inFile, truth.required[1]), true);
});

test('hits under another definition of the name do not count', () => {
  const result = { matches: [{ symbol: { path: 'src/other.py', span: 'L10-L20' }, hits: [inCaller, inFile] }] };
  assert.equal(scoreSymbol(truth, result, '').found, 0);
});

test('a miss is silent unless the plain output says the answer may be short', () => {
  const result = { matches: [{ symbol: definition, hits: [inCaller] }] };
  assert.equal(scoreSymbol(truth, result, 'caller').undercount, 'silent');
  assert.equal(scoreSymbol(truth, result, 'this may undercount').undercount, 'stated');
  const complete = { matches: [{ symbol: definition, hits: [inCaller, inFile] }] };
  assert.equal(scoreSymbol(truth, complete, '').undercount, 'none');
});

test('a reported caller outside the truth lowers precision', () => {
  const stray = { id: 'src/d.py#other', path: 'src/d.py', span: 'L1-L2' };
  const score = scoreSymbol(truth, { matches: [{ symbol: definition, hits: [inCaller, inFile, stray] }] }, '');
  const summary = summarise([score]);
  assert.equal(summary.recall, 1);
  assert.equal(summary.precision, 2 / 3);
  assert.equal(summary.perfect, 0);
});

test('recall pools calls across symbols and macro recall weighs symbols equally', () => {
  const big = { found: 9, required: 10, reported: 9, missed: [{}], falsePositives: [], undercount: 'silent' };
  const small = { found: 0, required: 1, reported: 0, missed: [{}], falsePositives: [], undercount: 'stated' };
  const summary = summarise([big, small]);
  assert.equal(summary.recall, 9 / 11);
  assert.equal(summary.macroRecall, 0.45);
  assert.equal(summary.silent, 1);
  assert.equal(summary.stated, 1);
});

test('the table shows the upstream column only when a baseline ran', () => {
  const repo = { name: 'r', repository: 'o/r', sha: 'abcdef0123', language: 'Rust' };
  const row = { recall: 0.5, required: 2 };
  assert.match(recallTable([repo], { r: row }, { r: row }), /Upstream/);
  assert.doesNotMatch(recallTable([repo], null, { r: row }), /Upstream/);
});

test('chain rules need every part of the qualified name in the chain', () => {
  const row = { file: 'src/b.py', chain: ['Outer', 'inner'] };
  const hit = (id) => ({ id, path: 'src/b.py' });
  assert.equal(satisfies(hit('src/b.py#Outer.inner'), row, 'chain'), true);
  assert.equal(satisfies(hit('src/b.py#inner'), row, 'chain'), true);
  assert.equal(satisfies(hit('src/b.py#Other.inner'), row, 'chain'), false);
  assert.equal(satisfies(hit('src/b.py'), row, 'chain'), false);
  assert.equal(satisfies(hit('src/b.py'), { file: 'src/b.py', chain: '<import>' }, 'chain'), true);
});

test('names rules need any part of the qualified name in the row', () => {
  const row = { file: 'src/b.rs', chain: ['run'] };
  const hit = { id: 'src/b.rs#Flask.run~2', name: 'run', path: 'src/b.rs' };
  assert.equal(satisfies(hit, row, 'names'), true);
  assert.equal(satisfies({ ...hit, id: 'src/b.rs#other', name: 'other' }, row, 'names'), false);
  assert.equal(satisfies({ ...hit, id: 'src/b.rs' }, { file: 'src/b.rs', chain: '<file>' }, 'names'), true);
});

test('chain and names rules match the target by file alone and honour optional rows', () => {
  const entry = {
    target: 'src/a.py',
    required: [{ file: 'src/b.py', chain: ['caller'] }],
    optional: [{ file: 'src/c.py', chain: '<import>' }],
  };
  const hits = [
    { id: 'src/b.py#caller', path: 'src/b.py' },
    { id: 'src/c.py', path: 'src/c.py' },
  ];
  const score = scoreSymbol(entry, { matches: [{ symbol: { path: 'src/a.py' }, hits }] }, '', 'chain');
  assert.equal(score.found, 1);
  assert.equal(score.falsePositives.length, 0);
});

test('the overall line pools calls and carries both builds', () => {
  const a = { found: 1, required: 4, good: 1, reported: 2, silent: 1, stated: 0 };
  const b = { found: 3, required: 4, good: 3, reported: 3, silent: 0, stated: 1 };
  assert.equal(pool([a, b]).recall, 0.5);
  assert.match(overallLine([a], [b]), /recall 0.25 to 0.75/);
  assert.match(overallLine(null, [b]), /recall 0.75/);
});

test('every pinned repository has 10 symbols and well-formed truth', () => {
  const repos = JSON.parse(readFileSync(new URL('../repos.json', import.meta.url), 'utf8'));
  assert.equal(repos.length, 21);
  for (const repo of repos) {
    assert.match(repo.sha, /^[0-9a-f]{40}$/);
    assert.ok(['span', 'chain', 'names'].includes(repo.rules), repo.name);
    const symbols = JSON.parse(readFileSync(new URL(`../truth/${repo.name}.json`, import.meta.url), 'utf8'));
    assert.equal(Object.keys(symbols).length, 10, repo.name);
    for (const [name, entry] of Object.entries(symbols)) {
      assert.ok(entry.target, name);
      if (repo.rules === 'span') assert.ok(entry.target_lines.length > 0, name);
      assert.ok(entry.required.length > 0, name);
      for (const row of entry.required) {
        assert.ok(row.file && row.chain, name);
        if (repo.rules === 'span') assert.ok(row.lines.length > 0, name);
      }
    }
  }
});
