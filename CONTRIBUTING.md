# Contributing

Report GrievousGreps bugs and request features in
[GitHub issues](https://github.com/EquityBot/GrievousGreps/issues), using a
public repository to show the problem. For Trail-Code itself, use
[trailhq/Trail-Code](https://github.com/trailhq/Trail-Code). For a suspected
security vulnerability, follow [SECURITY.md](SECURITY.md) instead of opening an
issue.

## Pull requests

Propose changes as a pull request against `main`. A change lands on `main` only
when these checks from [ci.yml](.github/workflows/ci.yml) pass:
`test (ubuntu-latest, Node 20)`, `test (ubuntu-latest, Node current)`,
`test (windows-latest, Node 20)`, `test (windows-latest, Node current)` and
`Node 24 WASM regression`.

Run what CI runs before opening one, with Node 20.16 or later on the 20 line,
or 22.3 or later:

```bash
npm ci
npx tsc --noEmit -p tsconfig.json
npx tsc --noEmit -p viewer/tsconfig.json
npm test
node --test benchmark/test/score.test.mjs
```

New functionality and bug fixes come with automated tests in `test/`, run by
`npm test` in CI.

Use public repositories or fabricated fixtures only, never private code,
credentials or `.env` content.
