// Tests for apply-changes.mjs: folding merged change files into the lists the
// app and the registry build read. Run: node --test apply-changes.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyChange, applyChanges, checkChange, parseDeprecated } from "./apply-changes.mjs";

const lists = () => ({
  verified: { _comment: "kept", verified: ["acme/old", { repo: "Acme/Warp", version: "1.0.0", commit: "c".repeat(40) }] },
  banned: { _comment: "kept", repos: [], owners: [], reason: {} },
  deprecated: { schema: 1, repos: {} },
  categories: { schema: 1, repos: { "acme/watermark": ["export"] } },
});

test("verify replaces the repo's entry, whatever its case or form, with the pinned one", () => {
  const out = applyChange(lists(), { kind: "verify", issue: 1, repo: "acme/warp", version: "1.2.0", commit: "a".repeat(40) });
  assert.deepEqual(out.verified.verified, ["acme/old", { repo: "acme/warp", version: "1.2.0", commit: "a".repeat(40) }]);
  const pinned = applyChange(lists(), { kind: "verify", issue: 1, repo: "ACME/old", version: "2.0.0", commit: "d".repeat(40) });
  assert.deepEqual(pinned.verified.verified[0], { repo: "ACME/old", version: "2.0.0", commit: "d".repeat(40) });
  assert.equal(pinned.verified._comment, "kept");
});

test("verify adds a repo not listed yet at the end", () => {
  const out = applyChange(lists(), { kind: "verify", issue: 1, repo: "new/one", version: "0.1.0", commit: "e".repeat(40) });
  assert.deepEqual(out.verified.verified.at(-1), { repo: "new/one", version: "0.1.0", commit: "e".repeat(40) });
});

test("ban adds a repo or an owner once, with its reason", () => {
  let out = applyChange(lists(), { kind: "ban", issue: 1, repo: "bad/one", reason: "Sends photos away" });
  out = applyChange(out, { kind: "ban", issue: 2, repo: "BAD/one", reason: "Sends photos away (1.1.0)" });
  out = applyChange(out, { kind: "ban", issue: 3, owner: "squatter", reason: "Typosquats" });
  assert.deepEqual(out.banned.repos, ["bad/one"]);
  assert.deepEqual(out.banned.owners, ["squatter"]);
  assert.deepEqual(out.banned.reason, { "bad/one": "Sends photos away (1.1.0)", squatter: "Typosquats" });
});

test("deprecate marks the repo, replacing an earlier mark", () => {
  let out = applyChange(lists(), { kind: "deprecate", issue: 1, repo: "acme/warp", replacedBy: null, message: "Gone" });
  out = applyChange(out, { kind: "deprecate", issue: 2, repo: "Acme/Warp", replacedBy: "acme/warp-2", message: null });
  assert.deepEqual(out.deprecated.repos, { "Acme/Warp": { replacedBy: "acme/warp-2", message: null } });
});

test("category sets the repo's override", () => {
  const out = applyChange(lists(), { kind: "category", issue: 1, repo: "Acme/Watermark", categories: ["export", "workflow"] });
  assert.deepEqual(out.categories.repos, { "Acme/Watermark": ["export", "workflow"] });
});

test("changes apply in issue order, so a later request wins", () => {
  const { lists: out, applied } = applyChanges(lists(), [
    { file: "changes/9.json", change: { kind: "deprecate", issue: 9, repo: "acme/warp", replacedBy: null, message: "second" } },
    { file: "changes/3.json", change: { kind: "deprecate", issue: 3, repo: "acme/warp", replacedBy: null, message: "first" } },
  ]);
  assert.equal(out.deprecated.repos["acme/warp"].message, "second");
  assert.deepEqual(applied, ["changes/3.json", "changes/9.json"]);
});

test("a malformed change is refused with what is wrong", () => {
  assert.match(checkChange({ kind: "verify", issue: 1, repo: "acme/warp" }).join(), /version/);
  assert.match(checkChange({ kind: "ban", issue: 1, reason: "x" }).join(), /repo or owner/);
  assert.match(checkChange({ kind: "teleport", issue: 1 }).join(), /kind/);
  assert.match(checkChange({ kind: "deprecate", issue: 1, repo: "../x" }).join(), /repo/);
  assert.deepEqual(checkChange({ kind: "category", issue: 1, repo: "a/b", categories: ["tone"] }), []);
  assert.throws(() => applyChanges(lists(), [{ file: "changes/1.json", change: { kind: "verify", issue: 1 } }]), /changes\/1\.json/);
});

test("deprecated.json reads into lowercased repo → mark, dropping bad rows", () => {
  const marks = parseDeprecated({
    schema: 1,
    repos: {
      "Acme/Warp": { replacedBy: "acme/next", message: "Use Next" },
      "acme/bare": {},
      "../bad": { replacedBy: null },
      "acme/odd": { replacedBy: "nope", message: 4 },
    },
  });
  assert.deepEqual(Object.fromEntries(marks), {
    "acme/warp": { replacedBy: "acme/next", message: "Use Next" },
    "acme/bare": { replacedBy: null, message: null },
    "acme/odd": { replacedBy: null, message: null },
  });
  assert.equal(parseDeprecated(null).size, 0);
});
