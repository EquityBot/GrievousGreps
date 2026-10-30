/**
 * A grammar deleted from an install must not read as a repo with no symbols.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import * as generic from "../src/graph/generic.js";

test("a build that cannot load a language's grammar warns and names the language", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "grammar-warning-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "a.zig"), "fn f() void {}\n");
  writeFileSync(join(root, "b.lua"), "function g() end\n");
  (generic as unknown as { hideGenericGrammarsForTest?: (w: string[]) => void }).hideGenericGrammarsForTest?.(["zig"]);
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.join(" "));
  try {
    await buildGraph(root);
  } finally {
    console.error = real;
    (generic as unknown as { hideGenericGrammarsForTest?: (w: string[]) => void }).hideGenericGrammarsForTest?.([]);
  }
  const warnings = lines.filter((l) => l.includes("grammar"));
  assert.equal(warnings.length, 1, lines.join("\n"));
  assert.match(warnings[0]!, /the zig grammar/);
});
