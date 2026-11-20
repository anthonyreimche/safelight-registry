#!/usr/bin/env node
// Folds merged registry requests into the lists. Each request a pull request
// merges is one file, changes/<issue>.json, written by requests.mjs; no two
// requests share a file, so their pull requests never conflict. Once merged,
// this script applies every change file in issue order to the list it edits,
// deletes the change files, and the workflow commits the result:
//
//   verify    → verified.json        { repo, version, commit } pin
//   ban       → banned.json          repos/owners + reason shown to users
//   deprecate → deprecated.json      { replacedBy, message } per repo
//   category  → category-overrides.json
//
// node apply-changes.mjs           apply, write the lists, delete the files
// node apply-changes.mjs --check   only check that every change file applies

import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { LIMITS, REPO } from "./store-fields.mjs";

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const SHA = /^[0-9a-f]{40}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MAX_REASON = 200;

const lc = (s) => String(s).toLowerCase();
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const plainRepo = (r) => typeof r === "string" && REPO.test(r) && r.split("/").every((p) => p !== "." && p !== "..");
const optionalText = (v, max) => v === null || (typeof v === "string" && v.trim().length > 0 && v.length <= max);

/** What is wrong with a change file's contents; [] when it applies. */
export function checkChange(c) {
  if (!isObject(c)) return ["a change must be an object"];
  const errors = [];
  if (!Number.isInteger(c.issue) || c.issue < 1) errors.push("issue must be the request's issue number");
  const needRepo = () => {
    if (!plainRepo(c.repo)) errors.push('repo must be "owner/repo"');
  };
  switch (c.kind) {
    case "verify":
      needRepo();
      if (typeof c.version !== "string" || !SEMVER.test(c.version)) errors.push("version must be a semver version");
      if (typeof c.commit !== "string" || !SHA.test(c.commit)) errors.push("commit must be a 40-character commit SHA");
      break;
    case "ban":
      if (plainRepo(c.repo) === (typeof c.owner === "string" && OWNER.test(c.owner)))
        errors.push("a ban names one repo or owner");
      if (typeof c.reason !== "string" || !c.reason.trim() || c.reason.length > MAX_REASON)
        errors.push(`reason must be 1–${MAX_REASON} characters`);
      break;
    case "deprecate":
      needRepo();
      if (!(c.replacedBy === null || plainRepo(c.replacedBy))) errors.push('replacedBy must be "owner/repo" or null');
      if (!optionalText(c.message, LIMITS.deprecatedMessage))
        errors.push(`message must be null or 1–${LIMITS.deprecatedMessage} characters`);
      break;
    case "category":
      needRepo();
      if (
        !Array.isArray(c.categories) ||
        c.categories.length < 1 ||
        c.categories.length > LIMITS.perRepo ||
        c.categories.some((s) => typeof s !== "string")
      )
        errors.push(`categories must be 1–${LIMITS.perRepo} slugs`);
      break;
    default:
      errors.push(`unknown kind "${c.kind}"`);
  }
  return errors;
}

const entryRepo = (e) => (typeof e === "string" ? e : e?.repo);

/** `lists` with `change` applied. Nothing in `lists` is changed in place. */
export function applyChange(lists, change) {
  const out = structuredClone(lists);
  const { kind } = change;
  if (kind === "verify") {
    const pin = { repo: change.repo, version: change.version, commit: change.commit };
    const entries = out.verified.verified;
    const at = entries.findIndex((e) => lc(entryRepo(e)) === lc(change.repo));
    if (at === -1) entries.push(pin);
    else entries[at] = pin;
  } else if (kind === "ban") {
    const banned = out.banned;
    const [listName, target] = change.repo ? ["repos", change.repo] : ["owners", change.owner];
    const key = lc(target);
    if (!banned[listName].some((x) => lc(x) === key)) banned[listName].push(key);
    banned.reason = { ...banned.reason, [key]: change.reason.trim() };
  } else if (kind === "deprecate") {
    out.deprecated.repos = withRepoKey(out.deprecated.repos, change.repo, {
      replacedBy: change.replacedBy,
      message: change.message,
    });
  } else if (kind === "category") {
    out.categories.repos = withRepoKey(out.categories.repos, change.repo, [...change.categories]);
  }
  return out;
}

/** `map` with `repo` set to `value`, replacing a key that differs only in case. */
function withRepoKey(map, repo, value) {
  const kept = Object.entries(map ?? {}).filter(([k]) => lc(k) !== lc(repo));
  return Object.fromEntries([...kept, [repo, value]]);
}

/** Apply `files` ({ file, change }) in issue order. Throws on the first one
 *  that doesn't check, naming its file. */
export function applyChanges(lists, files) {
  const ordered = [...files].sort((a, b) => a.change.issue - b.change.issue || a.file.localeCompare(b.file));
  let out = lists;
  for (const { file, change } of ordered) {
    const errors = checkChange(change);
    if (errors.length) throw new Error(`${file}: ${errors.join("; ")}`);
    out = applyChange(out, change);
  }
  return { lists: out, applied: ordered.map((f) => f.file) };
}

/** deprecated.json → lowercased repo → { replacedBy, message }. A bad
 *  replacement or message reads as null; a bad repo drops the row. */
export function parseDeprecated(doc) {
  const marks = new Map();
  if (!isObject(doc) || !isObject(doc.repos)) return marks;
  for (const [repo, mark] of Object.entries(doc.repos)) {
    if (!plainRepo(repo)) continue;
    const m = isObject(mark) ? mark : {};
    const message = typeof m.message === "string" ? m.message.trim() : "";
    marks.set(lc(repo), {
      replacedBy: plainRepo(m.replacedBy) && lc(m.replacedBy) !== lc(repo) ? m.replacedBy : null,
      message: message && message.length <= LIMITS.deprecatedMessage ? message : null,
    });
  }
  return marks;
}

// ── Files ──

export const LIST_FILES = {
  verified: "verified.json",
  banned: "banned.json",
  deprecated: "deprecated.json",
  categories: "category-overrides.json",
};
const EMPTY = { deprecated: { schema: 1, repos: {} }, categories: { schema: 1, repos: {} } };

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (e?.code === "ENOENT" && fallback) return structuredClone(fallback);
    throw new Error(`${path}: ${e.message}`);
  }
}

export async function readChangeFiles(dir = "changes") {
  let names;
  try {
    names = await readdir(dir);
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  return Promise.all(
    names
      .filter((n) => n.endsWith(".json"))
      .map(async (n) => ({ file: `${dir}/${n}`, change: await readJson(`${dir}/${n}`) })),
  );
}

async function main() {
  const check = process.argv.includes("--check");
  const files = await readChangeFiles();
  if (files.length === 0) {
    console.error("No change files.");
    return;
  }
  const lists = Object.fromEntries(
    await Promise.all(Object.entries(LIST_FILES).map(async ([k, f]) => [k, await readJson(f, EMPTY[k])])),
  );
  const { lists: out, applied } = applyChanges(lists, files);
  if (check) {
    console.error(`${applied.length} change file(s) apply cleanly.`);
    return;
  }
  for (const [k, f] of Object.entries(LIST_FILES))
    if (JSON.stringify(out[k]) !== JSON.stringify(lists[k])) await writeFile(f, JSON.stringify(out[k], null, 2) + "\n");
  for (const file of applied) await rm(file);
  console.error(`Applied ${applied.join(", ")}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("apply-changes failed:", e?.message || e);
    process.exit(1);
  });
}
