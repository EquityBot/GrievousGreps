# Caller benchmark

This harness measures how many real calls `callers` finds. It builds a graph of 21 pinned public repositories with the tool you name, asks for the callers of 10 symbols in each and prints recall against committed truth. It needs Node, git and network access to GitHub, and has no dependencies of its own.

## Run it

Build the tool first, then:

```bash
node benchmark/run.mjs --tool dist/bin/graft.js
```

To print the README's table with its upstream column, build upstream 0.28.0 in another folder and pass it as the baseline:

```bash
git clone https://github.com/trailhq/Trail-Code ../upstream
git -C ../upstream checkout a44da3dfb5894c8e316e320526041ef8e5ddbb8c
(cd ../upstream && npm ci)
node benchmark/run.mjs --tool dist/bin/graft.js --baseline ../upstream/dist/bin/graft.js
```

| Option | Effect |
| --- | --- |
| `--tool <path>` | The JavaScript entry point to score. Required. |
| `--baseline <path>` | A second entry point, shown as the Upstream column. |
| `--repos httpx,click` | Score only these repositories. |
| `--work <dir>` | Where clones and graphs go. The default is a folder in the system temp directory. |
| `--verbose` | Print each symbol's score and first 10 misses to stderr. |

The harness runs one repository at a time at below normal priority. It keeps the shallow clones for the next run and deletes each graph copy after scoring. It only builds and queries, and never runs the tool's test suite.

Each run points `HOME`, `USERPROFILE`, `TRAIL_HOME`, `CLAUDE_CONFIG_DIR` and `CODEX_HOME` at a scratch folder under the work folder, and `DOTENV_CONFIG_PATH` at a missing file. The tool therefore leaves your graphs, agent settings and hooks alone and loads no `.env` file. Telemetry and the hosted workspace are off for the run.

On Windows with Node 26, httpx took about 40 seconds per build at 60 files. tokio, tracing and the larger TypeScript repositories have not been timed through this harness, so run the full set on a machine that is otherwise idle.

## What it prints

The overall line and first table are what the README carries. Recall is required calls found divided by required calls, pooled across the repository's 10 symbols, so a symbol with many callers weighs more. The overall line pools every repository the same way, so tokio and tracing hold more than a third of its weight. The detail tables add:

- macro recall, the mean of each symbol's recall
- precision, the reported callers that match a required call, divided by all reported callers
- silent, the symbols with a miss and no statement in the plain output that the answer may be short
- stated, the symbols with a miss and such a statement
- perfect, the symbols with every required call found and no false positive

## Scoring rules

- Only hits under the target definition count. Hits under another definition of the same name neither help nor hurt.
- A required row is a real call that resolves to the target. Definitions, comments, strings, same-named locals and other definitions' callers are excluded.
- An optional row is a true reference that is not a call, such as an import line. It neither helps recall nor hurts precision.
- A module-level row (`<file>`) needs only a hit in the file.
- The harness stops with an error if a tool gives no readable JSON for any symbol in a repository, so a broken build cannot show as a recall of 0.00.

The truth was written in 3 rounds, and each repository keeps the rules it was preregistered under. `repos.json` names them:

| Rules | Repositories | The target matches on | A hit satisfies a row when |
| --- | --- | --- | --- |
| `names` | flask, hono, ripgrep | File | Any part of its qualified name is one of the row's names |
| `chain` | jotai, mdbook, seaborn, structlog | File | Every part of its qualified name is in the row's chain of enclosing names |
| `span` | The other 14 | File and definition line | Its span contains one of the row's call lines |

`span` is the strictest. Rows under different rules are therefore not strictly comparable, and the overall line pools them anyway.

Under `span`, a file-level hit is never a false positive. Under the other 2, any hit that matches no required or optional row is one.

## Truth

`truth/<repo>.json` holds, per symbol, the target file, a note on what makes the symbol hard (`category`, where one was written), the required rows and any optional rows. `span` truth also has the definition lines. `repos.json` pins each repository to a commit.

A verifier wrote each set with tree-sitter, `rg` and reading, and committed it to a local log before any build ran on that repository. That log is not public, so the order of events rests on this statement.

Limits of the truth:

- It has one author and no second reviewer, and it may hold errors.
- One correction came after a first scoring pass: the target lines of httpx `to_bytes` and `create_ssl_context` were off by one (79 and 23). No required row changed.
- Two symbols were replaced before any run, because the first choice had no call rows or no longer existed: click `get_app_dir` and table `getMemoOptions`.
- Earlier builds have run on all 21 repositories, so fixes made in between may have been shaped by their results. None is an unseen holdout any more.
- The tracing and tokio symbols were chosen for repeated names and cross-crate calls, so those rows test the known weak spot on purpose.
- It is 210 symbols on 21 repositories. It does not estimate recall on your code.

## Recorded runs

The README's draft figures came from upstream `a44da3dfb5894c8e316e320526041ef8e5ddbb8c` (0.28.0) and an earlier patched build, `949d829`, using the verifier's own scripts. Applying this harness's scorer to those stored outputs gave the same figures for all 21 repositories, including the overall 0.31 to 0.78. Regenerate them with this harness on the final build.
