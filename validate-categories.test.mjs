// Tests for validate-categories.mjs. Run: node --test validate-categories.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateStoreConfig } from "./validate-categories.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, "validate-categories.mjs");
const committed = (name) => JSON.parse(readFileSync(path.join(here, name), "utf8"));

test("the committed files are valid", () => {
  assert.deepEqual(validateStoreConfig(committed("categories.json"), committed("category-overrides.json")), []);
});

test("errors name the file they come from", () => {
  const badOverrides = { schema: 1, repos: { "acme/one": ["nope"] } };
  assert.deepEqual(validateStoreConfig(committed("categories.json"), badOverrides), [
    'category-overrides.json: repos["acme/one"] names unknown category "nope"',
  ]);
  assert.deepEqual(validateStoreConfig({ schema: 1, categories: [] }, committed("category-overrides.json")), [
    "categories.json: categories must be a non-empty array",
  ]);
});

test("the CLI exits 0 on the committed files and 1 on a broken one", () => {
  assert.equal(spawnSync(process.execPath, [script], { cwd: here }).status, 0);
  const dir = mkdtempSync(path.join(tmpdir(), "categories-"));
  try {
    const bad = path.join(dir, "categories.json");
    writeFileSync(bad, JSON.stringify({ schema: 1, categories: [] }));
    const run = spawnSync(process.execPath, [script, bad, path.join(here, "category-overrides.json")], {
      encoding: "utf8",
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /categories must be a non-empty array/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the CLI reports a file that isn't JSON", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "categories-"));
  try {
    const bad = path.join(dir, "categories.json");
    writeFileSync(bad, "{ not json");
    const run = spawnSync(process.execPath, [script, bad, path.join(here, "category-overrides.json")], {
      encoding: "utf8",
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
