/**
 * An absolute Python import resolves against the repo's import roots, as Python would,
 * so a file lower down that shares a package's name or a stdlib module's name is never
 * its target.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { extractFile } from "../src/graph/extract.js";
import { resolveEdges } from "../src/graph/resolve.js";
import { warmDepthGrammars } from "../src/graph/depth-parser.js";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";

await warmDepthGrammars(["python"]);

function calls(files: Record<string, string>, source: string, pythonRoots: string[] = ["", "src"]): string[] {
  const extracted = Object.entries(files).map(([path, text]) => extractFile(path, text, "python"));
  return resolveEdges(extracted.flatMap((x) => x.nodes), extracted.flatMap((x) => x.rawEdges), { pythonRoots })
    .filter((e) => e.source === source && e.relation === "calls")
    .map((e) => e.target)
    .sort();
}

const flash = "def flash():\n    pass\n";
const useFlash = "from flask import flash\ndef run():\n    flash()\n";

test("a nested file sharing a package's name never shadows the package", () => {
  const files = {
    "src/flask/__init__.py": flash,
    "tests/apps/inner/flask.py": "def flash():\n    pass\n",
  };
  for (const importer of ["tests/test_a.py", "tests/apps/inner/sibling.py", "tests/apps/test_b.py", "examples/app.py"]) {
    assert.deepEqual(calls({ ...files, [importer]: useFlash }, `${importer}#run`), ["src/flask/__init__.py#flash"], importer);
  }
  assert.deepEqual(
    calls({ "src/flask/__init__.py": flash, "tests/apps/flask.py": useFlash }, "tests/apps/flask.py#run"),
    ["src/flask/__init__.py#flash"],
    "the colliding file itself",
  );
});

test("a stdlib name not under a root resolves to nothing, however close a same-named file is", () => {
  const jsonPackage = "src/flask/json/__init__.py";
  for (const statement of ["import json as _json\ndef run():\n    _json.dumps()\n", "import json\ndef run():\n    json.dumps()\n", "from json import dumps\ndef run():\n    dumps()\n"]) {
    const files = { [jsonPackage]: "def dumps():\n    pass\n", "src/flask/__init__.py": "" };
    assert.deepEqual(calls({ ...files, "src/flask/app.py": statement }, "src/flask/app.py#run"), [], statement);
    assert.deepEqual(calls({ [jsonPackage]: `${statement}\ndef dumps():\n    pass\n` }, `${jsonPackage}#run`), [], `no self-edge: ${statement}`);
  }
});

test("every import form walks to the target through the one resolver", () => {
  const files = {
    "pkg/__init__.py": "from .mod import exported\ndef top():\n    pass\n",
    "pkg/mod.py": "def exported():\n    pass\ndef inner():\n    pass\nclass Thing:\n    def make(self):\n        pass\n",
  };
  const cases: [string, string[]][] = [
    ["import pkg\ndef run():\n    pkg.top()\n", ["pkg/__init__.py#top"]],
    ["import pkg\ndef run():\n    pkg.exported()\n", ["pkg/mod.py#exported"]],
    ["import pkg.mod\ndef run():\n    pkg.mod.inner()\n", ["pkg/mod.py#inner"]],
    ["import pkg as p\ndef run():\n    p.top()\n", ["pkg/__init__.py#top"]],
    ["import pkg as p\ndef run():\n    p.mod.inner()\n", ["pkg/mod.py#inner"]],
    ["import pkg.mod as m\ndef run():\n    m.inner()\n", ["pkg/mod.py#inner"]],
    ["from pkg import mod\ndef run():\n    mod.inner()\n", ["pkg/mod.py#inner"]],
    ["from pkg.mod import Thing\ndef run():\n    Thing.make()\n", ["pkg/mod.py#Thing.make"]],
    ["import pkg.mod\ndef run():\n    pkg.mod.Thing.make()\n", ["pkg/mod.py#Thing.make"]],
    ["def run():\n    import pkg\n    pkg.top()\n", ["pkg/__init__.py#top"]],
    ["import pkg\ndef run(pkg):\n    pkg.top()\n", []],
    ["import requests\ndef run():\n    requests.top()\n", []],
  ];
  for (const [consumer, want] of cases) assert.deepEqual(calls({ ...files, "consumer.py": consumer }, "consumer.py#run"), want, consumer);
});

test("a class method reached through an import may be inherited", () => {
  assert.deepEqual(calls({
    "pkg/base.py": "class Base:\n    def inherited(self):\n        pass\n",
    "pkg/child.py": "from .base import Base\nclass Child(Base):\n    pass\n",
    "consumer.py": "from pkg.child import Child\ndef run():\n    Child.inherited()\n",
  }, "consumer.py#run"), ["pkg/base.py#Base.inherited"]);
});

test("a test directory is a root for its own files alone", () => {
  const files = { "tests/support/__init__.py": "def help_out():\n    pass\n", "src/app/__init__.py": "" };
  const consumer = "from support import help_out\ndef run():\n    help_out()\n";
  assert.deepEqual(calls({ ...files, "tests/test_a.py": consumer }, "tests/test_a.py#run"), ["tests/support/__init__.py#help_out"]);
  assert.deepEqual(calls({ ...files, "src/app/code.py": consumer }, "src/app/code.py#run"), []);
});

test("a script's own folder is a root for it, a package's folder is not", () => {
  const consumer = "from neighbour import f\ndef run():\n    f()\n";
  const neighbour = "def f():\n    pass\n";
  assert.deepEqual(calls({ "tools/neighbour.py": neighbour, "tools/run.py": consumer }, "tools/run.py#run"), ["tools/neighbour.py#f"]);
  assert.deepEqual(calls({ "pkg/__init__.py": "", "pkg/neighbour.py": neighbour, "pkg/run.py": consumer }, "pkg/run.py#run"), []);
});

test("a package 2 subprojects hold resolves in the importer's own, and elsewhere is unresolved", () => {
  const files = { "a/pkg/__init__.py": flash, "b/pkg/__init__.py": flash };
  const consumer = "from pkg import flash\ndef run():\n    flash()\n";
  const roots = ["", "a", "b"];
  assert.deepEqual(calls({ ...files, "a/tests/t.py": consumer }, "a/tests/t.py#run", roots), ["a/pkg/__init__.py#flash"]);
  assert.deepEqual(calls({ ...files, "c/t.py": consumer }, "c/t.py#run", roots), []);
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "py-roots-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

async function builtCalls(files: Record<string, string>, source: string): Promise<string[]> {
  const root = repo(files);
  await buildGraph(root);
  const graph = readGraph(wiringPath(join(root, "graft")));
  return graph!.edges.filter((e) => e.source === source && e.relation === "calls").map((e) => e.target);
}

test("configuration names the roots, whichever way each build tool spells it", async () => {
  const lib = { "lib/pkg/__init__.py": flash, "elsewhere/pkg/__init__.py": flash, "tests/t.py": "from pkg import flash\ndef run():\n    flash()\n" };
  const configs: [string, string][] = [
    ["pyproject.toml", "[tool.setuptools.packages.find]\nwhere = [\"lib\"]\n"],
    ["pyproject.toml", "[tool.setuptools.package-dir]\n\"\" = \"lib\"\n"],
    ["pyproject.toml", "[tool.hatch.build.targets.wheel]\npackages = [\"lib/pkg\"]\n"],
    ["pyproject.toml", "[tool.poetry]\npackages = [{ include = \"pkg\", from = \"lib\" }]\n"],
    ["pyproject.toml", "[tool.pytest.ini_options]\npythonpath = [\"lib\"]\n"],
    ["setup.cfg", "[options]\npackage_dir =\n    = lib\n"],
    ["setup.py", "from setuptools import setup, find_packages\nsetup(package_dir={\"\": \"lib\"})\n"],
    ["setup.py", "from setuptools import setup, find_packages\nsetup(packages=find_packages(where=\"lib\"))\n"],
  ];
  for (const [name, text] of configs) {
    assert.deepEqual(await builtCalls({ ...lib, [name]: text }, "tests/t.py#run"), ["lib/pkg/__init__.py#flash"], `${name}: ${text}`);
  }
  assert.deepEqual(
    await builtCalls({ "src/pkg/__init__.py": flash, "pyproject.toml": "[project]\nname = \"x\"\n", "tests/t.py": "from pkg import flash\ndef run():\n    flash()\n" }, "tests/t.py#run"),
    ["src/pkg/__init__.py#flash"],
    "src layout",
  );
});

test("a call into an in-repo module whose name does not resolve is said, with the name, in callers", async () => {
  const root = repo({
    "pyproject.toml": "[project]\nname = \"x\"\n",
    "pkg/__init__.py": "def visible():\n    pass\nsingleton = object()\n",
    "pkg/other.py": "def missing():\n    pass\n",
    "consumer.py": "import pkg\nimport requests\ndef run():\n    pkg.missing()\n    pkg.nowhere()\n    pkg.singleton.visible()\n    requests.visible()\n",
  });
  await buildGraph(root);
  const callers = (name: string) => {
    const home = mkdtempSync(join(tmpdir(), "py-roots-home-"));
    const r = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src/cli.ts"), "callers", name, root], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, USERPROFILE: home, DO_NOT_TRACK: "1", TRAIL_CLOUD: "0", DOTENV_CONFIG_PATH: "NUL" },
    });
    return r.stdout + r.stderr;
  };
  assert.match(callers("missing"), /may be incomplete.*"missing".*consumer\.py#run \(through pkg\)/);
  assert.match(callers("nowhere"), /may be incomplete.*"nowhere".*consumer\.py#run \(through pkg\)/, "no symbol of that name anywhere");
  assert.doesNotMatch(callers("visible"), /requests/, "a module outside the repo says nothing");
});

test("a name with one in-repo target keeps its edge, however the import is wrapped", () => {
  const files = { "pkg/__init__.py": "", "pkg/impl.py": "def f():\n    pass\nclass C:\n    def m(self):\n        pass\n", "pkg/other.py": "def f():\n    pass\n" };
  const keeps: [string, string[]][] = [
    ["try:\n    from pkg.impl import f\nexcept ImportError:\n    f = None\ndef run():\n    f()\n", ["pkg/impl.py#f"]],
    ["try:\n    from pkg.impl import f\nexcept ImportError:\n    from thirdparty import f\ndef run():\n    f()\n", ["pkg/impl.py#f"]],
    ["try:\n    from thirdparty import f\nexcept ImportError:\n    from pkg.impl import f\ndef run():\n    f()\n", ["pkg/impl.py#f"]],
    ["try:\n    import pkg.impl as m\nexcept ImportError:\n    m = None\ndef run():\n    m.f()\n", ["pkg/impl.py#f"]],
    ["try:\n    from pkg.impl import C\nexcept ImportError:\n    C = None\ndef run():\n    C.m()\n", ["pkg/impl.py#C.m"]],
    ["from pkg.impl import f\ndef run():\n    f()\ndel f\n", ["pkg/impl.py#f"]],
    ["from pkg.impl import f\nfrom pkg.impl import f\ndef run():\n    f()\n", ["pkg/impl.py#f"]],
    ["if flag:\n    from pkg.impl import f\ndef run():\n    f()\n", ["pkg/impl.py#f"]],
  ];
  for (const [consumer, want] of keeps) assert.deepEqual(calls({ ...files, "consumer.py": consumer }, "consumer.py#run"), want, consumer);
  const drops = [
    "from pkg.impl import f\nfrom pkg.other import f\ndef run():\n    f()\n",
    "try:\n    from pkg.impl import f\nexcept ImportError:\n    from pkg.other import f\ndef run():\n    f()\n",
    "from pkg.impl import f\nf = make()\ndef run():\n    f()\n",
    "try:\n    from thirdparty import f\nexcept ImportError:\n    f = None\ndef run():\n    f()\n",
  ];
  for (const consumer of drops) assert.deepEqual(calls({ ...files, "consumer.py": consumer }, "consumer.py#run"), [], consumer);
});

test("the warning for a genuine rebinding says what happened", async () => {
  const root = repo({
    "pyproject.toml": "[project]\nname = \"x\"\n",
    "pkg/__init__.py": "",
    "pkg/a.py": "def f():\n    pass\n",
    "pkg/b.py": "def f():\n    pass\n",
    "consumer.py": "from pkg.a import f\nfrom pkg.b import f\ndef run():\n    f()\n",
  });
  await buildGraph(root);
  const home = mkdtempSync(join(tmpdir(), "py-roots-home-"));
  const r = spawnSync(process.execPath, ["--import", "tsx", join(process.cwd(), "src/cli.ts"), "callers", "f", root], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, DO_NOT_TRACK: "1", TRAIL_CLOUD: "0", DOTENV_CONFIG_PATH: "NUL" },
  });
  assert.match(r.stdout + r.stderr, /consumer\.py#run \(an assignment or a second import gives it more than one target\)/);
  assert.doesNotMatch(r.stdout + r.stderr, /conditional import/);
});
