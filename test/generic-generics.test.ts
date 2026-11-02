/**
 * Property test for the scan that drops a Rust call path's generic arguments: for any path built from
 * plain segments with turbofish arguments made of real Rust type and const syntax, what is left is exactly
 * the segments. The arguments mix the cases the scan must see through: nested angles, `->`, comparisons and
 * shifts in const blocks, lifetimes, and brackets, angles and quotes inside char, string and raw string literals.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { withoutGenerics } from "../src/graph/generic.js";

const literal = fc.constantFrom(
  "'}'", "'<'", "'>'", "'{'", "')'", "'\\''", "'\\\\'", "'\\u{3c}'", "b'>'", "'\"'",
  '"<>"', '"a\\"b>"', '"}"', 'r"\\"', 'r#"a"}>"#', 'br##"}"#>"##', 'cr"<"',
);
const space = fc.constantFrom("", "", " ", "\n  ");

const { type } = fc.letrec<{ type: string; expr: string }>((tie) => ({
  type: fc.oneof(
    { depthSize: "small" },
    fc.constantFrom("u8", "T", "String", "a::B", "Self", "_", "()", "!", "'a", "'static"),
    fc.tuple(fc.constantFrom("Vec", "Box", "a::Foo"), fc.array(tie("type"), { minLength: 1, maxLength: 3 }), space)
      .map(([name, args, s]) => `${name}<${s}${args.join(`,${s}`)}${s}>`),
    tie("type").map((t) => `&'a ${t}`),
    fc.array(tie("type"), { maxLength: 3 }).map((ts) => `(${ts.join(", ")})`),
    fc.tuple(tie("type"), tie("expr")).map(([t, e]) => `[${t}; { ${e} }]`),
    fc.tuple(fc.array(tie("type"), { maxLength: 2 }), tie("type")).map(([args, r]) => `fn(${args.join(", ")}) -> ${r}`),
    fc.tuple(tie("type"), tie("type")).map(([a, r]) => `Box<dyn Fn(${a}) -> ${r}>`),
    tie("type").map((t) => `<${t} as a::Tr<u8>>::Out`),
    tie("expr").map((e) => `{ ${e} }`),
    literal,
  ),
  expr: fc.oneof(
    { depthSize: "small" },
    literal,
    fc.constantFrom("N < 2", "N >> 1", "1 <= N", "N > M", "if N < 2 { 1 } else { 2 }"),
    tie("expr").map((e) => `{ ${e} }`),
    literal.map((l) => `'a: { break 'a ${l} }`),
    tie("type").map((t) => `f::<${t}>()`),
    fc.tuple(tie("expr"), tie("expr")).map(([a, b]) => `[${a}, ${b}].len()`),
  ),
}));

const segment = fc.tuple(
  fc.constantFrom("lara", "Croft", "new", "r#type", "b_2"),
  fc.option(fc.array(type, { minLength: 1, maxLength: 3 }), { nil: undefined }),
  space,
);

test("a call path keeps exactly its segments whatever its generic arguments hold", () => {
  fc.assert(
    fc.property(fc.array(segment, { minLength: 1, maxLength: 4 }), (segments) => {
      const path = segments
        .map(([name, args, s]) => (args ? `${name}${s}::${s}<${s}${args.join(`,${s}`)}${s}>` : name))
        .join("::");
      assert.equal(withoutGenerics(path).replace(/\s+/g, ""), segments.map(([name]) => name).join("::"), path);
    }),
    { numRuns: 2000 },
  );
});
