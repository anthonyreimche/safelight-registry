// Tests for validate-kits.mjs. Run: node --test validate-kits.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LIMITS, validateKits } from "./validate-kits.mjs";

const ctx = {
  verified: { verified: ["acme/one", { repo: "acme/two", version: "1.0.0" }] },
  registry: [{ fullName: "Acme/One" }, { fullName: "acme/two" }],
  banned: { repos: [], owners: [] },
};
const ext = (repo, extra = {}) => ({ repo, name: "One", summary: "Does a thing.", ...extra });
const kit = (extra = {}) => ({
  id: "film",
  name: "Film looks",
  description: "Film.",
  icon: "film",
  extensions: [ext("acme/one")],
  ...extra,
});
const doc = (kits) => ({ schema: 1, kits });
const errors = (d, c = ctx) => validateKits(d, c).join("\n");

test("accepts a valid document, pinned entries included", () => {
  assert.deepEqual(validateKits(doc([kit({ extensions: [ext("acme/one"), ext("Acme/Two")] })]), ctx), []);
});

test("rejects a wrong schema and a missing kits array", () => {
  assert.match(errors({ schema: 2, kits: [] }), /schema must be 1/);
  assert.match(errors({ schema: 1 }), /kits must be an array/);
  assert.match(errors([]), /must be an object/);
});

test("rejects bad and duplicate kit ids", () => {
  assert.match(errors(doc([kit({ id: "Film!" })])), /kits\[0\]\.id must match/);
  assert.match(errors(doc([kit(), kit()])), /kits\[1\]\.id "film" is a duplicate/);
});

test("rejects empty or over-long text", () => {
  assert.match(errors(doc([kit({ name: " " })])), /kits\[0\]\.name must not be empty/);
  assert.match(errors(doc([kit({ name: "x".repeat(LIMITS.kitName + 1) })])), /kits\[0\]\.name is 41 characters; the limit is 40/);
  assert.match(errors(doc([kit({ description: "x".repeat(LIMITS.kitDescription + 1) })])), /description is 161 characters/);
  assert.match(errors(doc([kit({ extensions: [ext("acme/one", { name: "x".repeat(LIMITS.extensionName + 1) })] })])), /extensions\[0\]\.name is 49 characters/);
  assert.match(errors(doc([kit({ extensions: [ext("acme/one", { summary: "x".repeat(LIMITS.extensionSummary + 1) })] })])), /summary is 141 characters/);
});

test("rejects an unknown icon", () => {
  assert.match(errors(doc([kit({ icon: "rocket" })])), /icon must be one of/);
});

test("rejects too many kits and too many extensions", () => {
  const kits = Array.from({ length: LIMITS.kits + 1 }, (_, i) => kit({ id: `k${i}` }));
  assert.match(errors(doc(kits)), /at most 8 kits/);
  assert.equal(LIMITS.extensionsPerKit, 24);
  const many = Array.from({ length: LIMITS.extensionsPerKit + 1 }, () => ext("acme/one"));
  assert.match(errors(doc([kit({ extensions: many })])), /at most 24 extensions/);
});

test("accepts a boolean default and rejects anything else", () => {
  assert.deepEqual(validateKits(doc([kit({ default: true })]), ctx), []);
  assert.deepEqual(validateKits(doc([kit({ default: false })]), ctx), []);
  for (const value of ["yes", 1, null])
    assert.match(errors(doc([kit({ default: value })])), /kits\[0\]\.default must be true or false/);
});

test("rejects an empty kit", () => {
  assert.match(errors(doc([kit({ extensions: [] })])), /extensions must be a non-empty array/);
});

test("rejects malformed and duplicate repos", () => {
  assert.match(errors(doc([kit({ extensions: [ext("not-a-repo")] })])), /repo must be "owner\/repo"/);
  assert.match(errors(doc([kit({ extensions: [ext("acme/one"), ext("ACME/one")] })])), /listed twice in this kit/);
});

test("rejects repos that aren't verified, aren't in the registry, or are banned", () => {
  const c = {
    verified: { verified: ["acme/one", "evil/x", "acme/gone"] },
    registry: [{ fullName: "acme/one" }, { fullName: "evil/x" }, { fullName: "acme/new" }],
    banned: { repos: ["acme/one"], owners: ["evil"] },
  };
  const out = errors(doc([kit({ extensions: [ext("acme/one"), ext("evil/x"), ext("acme/gone"), ext("acme/new")] })]), c);
  assert.match(out, /acme\/one is banned/);
  assert.match(out, /evil\/x is banned/);
  assert.match(out, /acme\/gone is not in registry\.json/);
  assert.match(out, /acme\/new is not in verified\.json/);
});

test("rejects a malformed minAppVersion", () => {
  assert.match(errors(doc([kit({ extensions: [ext("acme/one", { minAppVersion: "soon" })] })])), /minAppVersion must be x\.y\.z/);
  assert.deepEqual(validateKits(doc([kit({ extensions: [ext("acme/one", { minAppVersion: "3.0.0" })] })]), ctx), []);
});

test("the published kits.json is valid", () => {
  const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
  assert.deepEqual(
    validateKits(read("./kits.json"), {
      verified: read("./verified.json"),
      registry: read("./registry.json"),
      banned: read("./banned.json"),
    }),
    [],
  );
});
