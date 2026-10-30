// Scoring rules for the caller benchmark. No I/O, so the tests can run offline.
//
// The truth was written in 3 rounds, each with its own row format, and repos.json
// names the rules each repository was preregistered under:
//   span   a hit's span contains one of the row's call lines
//   chain  a hit's qualified name fits the row's chain of enclosing names
//   names  any part of a hit's qualified name is one of the row's names

const UNDERCOUNT = /may undercount|may be incomplete|not listed|did not resolve|dropped|undercount/i;

function lineRange(span) {
  const numbers = String(span ?? '').match(/\d+/g);
  return numbers ? [Number(numbers[0]), Number(numbers.at(-1))] : null;
}

export function spanContains(span, lines) {
  const range = lineRange(span);
  return range !== null && lines.some((line) => range[0] <= line && line <= range[1]);
}

const normalise = (path) => path.replaceAll('\\', '/');

function qualifiedName(hit) {
  const hash = hit.id.indexOf('#');
  return hash < 0 ? null : hit.id.slice(hash + 1).replace(/~\d+/g, '');
}

const nameParts = (qualified) => qualified.split(/\.|::/).filter(Boolean);

const MATCHERS = {
  span: (hit, row) => row.chain === '<file>' || spanContains(hit.span, row.lines),
  chain(hit, row) {
    if (row.chain === '<file>') return true;
    const qualified = qualifiedName(hit);
    if (row.chain === '<import>') return qualified === null;
    if (qualified === null) return false;
    const parts = nameParts(qualified);
    return parts.every((part) => row.chain.includes(part));
  },
  names(hit, row) {
    if (row.chain === '<file>') return true;
    const qualified = qualifiedName(hit) ?? '';
    return [...qualified.split(/\.|::/), qualified, hit.name].some((part) => row.chain.includes(part));
  },
};

// A hit must be in the row's file, then pass the repository's matcher.
export function satisfies(hit, row, rules = 'span') {
  return normalise(hit.path) === row.file && MATCHERS[rules](hit, row);
}

function isTarget(symbol, truth, rules) {
  if (normalise(symbol.path) !== truth.target) return false;
  return rules !== 'span' || spanContains(symbol.span, truth.target_lines);
}

// Only hits under the target definition count. Hits under another definition of
// the same name neither help nor hurt. Optional rows are true references that are
// not calls: they neither help recall nor hurt precision.
export function scoreSymbol(truth, result, plainOutput, rules = 'span') {
  const hits = new Map();
  for (const match of result.matches ?? []) {
    if (!isTarget(match.symbol, truth, rules)) continue;
    for (const hit of match.hits ?? []) hits.set(hit.id, hit);
  }
  const reported = [...hits.values()];
  const accepted = [...truth.required, ...(truth.optional ?? [])];
  const missed = truth.required.filter((row) => !reported.some((hit) => satisfies(hit, row, rules)));
  const falsePositives = reported.filter(
    (hit) => (rules !== 'span' || hit.id.includes('#')) && !accepted.some((row) => satisfies(hit, row, rules)),
  );
  const found = truth.required.length - missed.length;
  let undercount = 'none';
  if (missed.length > 0) undercount = UNDERCOUNT.test(plainOutput) ? 'stated' : 'silent';
  return { found, required: truth.required.length, reported: reported.length, missed, falsePositives, undercount };
}

export function summarise(symbolScores) {
  const sum = (pick) => symbolScores.reduce((total, score) => total + pick(score), 0);
  const required = sum((s) => s.required);
  const found = sum((s) => s.found);
  const reported = sum((s) => s.reported);
  const good = reported - sum((s) => s.falsePositives.length);
  return {
    symbols: symbolScores.length,
    found,
    required,
    recall: found / required,
    macroRecall: sum((s) => s.found / s.required) / symbolScores.length,
    good,
    reported,
    precision: reported === 0 ? null : good / reported,
    silent: symbolScores.filter((s) => s.undercount === 'silent').length,
    stated: symbolScores.filter((s) => s.undercount === 'stated').length,
    perfect: symbolScores.filter((s) => s.missed.length === 0 && s.falsePositives.length === 0).length,
  };
}

const two = (value) => (value === null ? 'n/a' : value.toFixed(2));

// Pools every repository, so a repository with many calls weighs more.
export function pool(summaries) {
  const sum = (pick) => summaries.reduce((total, s) => total + pick(s), 0);
  const [found, required, good, reported] = [sum((s) => s.found), sum((s) => s.required), sum((s) => s.good), sum((s) => s.reported)];
  return {
    repositories: summaries.length,
    found,
    required,
    recall: found / required,
    precision: reported === 0 ? null : good / reported,
    silent: sum((s) => s.silent),
    stated: sum((s) => s.stated),
  };
}

// The line and table the README carries.
export function overallLine(upstream, patched) {
  const p = pool(patched);
  const counted = `${p.repositories} repositories and ${p.found} of ${p.required} calls`;
  if (!upstream) {
    return `**Overall:** recall ${two(p.recall)} (${counted}), precision ${two(p.precision)}, silent undercounts ${p.silent}.`;
  }
  const u = pool(upstream);
  return (
    `**Overall, upstream to patched:** recall ${two(u.recall)} to ${two(p.recall)} (${counted} on the patched build), ` +
    `precision ${two(u.precision)} to ${two(p.precision)}, silent undercounts ${u.silent} to ${p.silent}.`
  );
}

export function recallTable(repos, upstream, patched) {
  const columns = ['Repository', 'Language', 'Calls in truth'];
  if (upstream) columns.push('Upstream');
  columns.push('Patched');
  const lines = [`| ${columns.join(' | ')} |`, `|${columns.map(() => ' --- ').join('|')}|`];
  for (const repo of repos) {
    const cells = [`${repo.repository} @ ${repo.sha.slice(0, 7)}`, repo.language, patched[repo.name].required];
    if (upstream) cells.push(two(upstream[repo.name].recall));
    cells.push(two(patched[repo.name].recall));
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

export function detailTable(repos, label, summaries) {
  const lines = [
    `${label}:`,
    '| Repository | Recall | Macro recall | Precision | Silent | Stated | Perfect |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const repo of repos) {
    const s = summaries[repo.name];
    lines.push(
      `| ${repo.name} | ${s.found}/${s.required} = ${two(s.recall)} | ${two(s.macroRecall)} | ` +
        `${s.good}/${s.reported} = ${two(s.precision)} | ${s.silent} | ${s.stated} | ${s.perfect}/${s.symbols} |`,
    );
  }
  return lines.join('\n');
}
