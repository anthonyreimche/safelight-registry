// Checks kits.json, the Safelight welcome setup's starter kits, against the
// rules the app applies when it reads the file
// (safelight src/modules/welcome/setup/kits.ts) and against this registry:
// every repo must be in verified.json, published in registry.json, and not
// banned. CI runs it on every change; `node validate-kits.mjs` locally.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LIMITS = {
  kits: 8,
  extensionsPerKit: 24,
  kitName: 40,
  kitDescription: 160,
  extensionName: 48,
  extensionSummary: 140,
};
export const ICONS = ["film", "palette", "detail", "organise", "speed", "import", "style"];

const KIT_ID = /^[a-z0-9-]{1,32}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const VERSION = /^\d+\.\d+\.\d+$/;

const lc = (s) => String(s ?? "").trim().toLowerCase();
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

const verifiedSet = (verified) =>
  new Set((verified?.verified ?? []).map((e) => lc(typeof e === "string" ? e : e?.repo)));
const registrySet = (registry) =>
  new Set((Array.isArray(registry) ? registry : registry?.extensions ?? []).map((e) => lc(e?.fullName)));
const banned = (list, repo) =>
  (list?.repos ?? []).map(lc).includes(repo) ||
  (list?.owners ?? []).map(lc).includes(repo.split("/")[0]);

function checkText(errors, at, value, min, max) {
  if (typeof value !== "string") {
    errors.push(`${at} must be a string`);
    return;
  }
  const length = value.trim().length;
  if (length < min) errors.push(`${at} must not be empty`);
  if (length > max) errors.push(`${at} is ${length} characters; the limit is ${max}`);
}

export function validateKits(doc, { verified, registry, banned: bannedList }) {
  if (!isObject(doc)) return ["kits.json must be an object"];
  const errors = [];
  if (doc.schema !== 1) errors.push("schema must be 1");
  if (!Array.isArray(doc.kits)) return [...errors, "kits must be an array"];
  if (doc.kits.length > LIMITS.kits)
    errors.push(`at most ${LIMITS.kits} kits (found ${doc.kits.length})`);
  const okVerified = verifiedSet(verified);
  const okRegistry = registrySet(registry);
  const ids = new Set();

  doc.kits.forEach((kit, i) => {
    const at = `kits[${i}]`;
    if (!isObject(kit)) {
      errors.push(`${at} must be an object`);
      return;
    }
    if (typeof kit.id !== "string" || !KIT_ID.test(kit.id))
      errors.push(`${at}.id must match ${KIT_ID}`);
    else if (ids.has(kit.id)) errors.push(`${at}.id "${kit.id}" is a duplicate`);
    else ids.add(kit.id);
    checkText(errors, `${at}.name`, kit.name, 1, LIMITS.kitName);
    checkText(errors, `${at}.description`, kit.description ?? "", 0, LIMITS.kitDescription);
    if (kit.icon !== undefined && !ICONS.includes(kit.icon))
      errors.push(`${at}.icon must be one of ${ICONS.join(", ")}`);
    if (kit.default !== undefined && typeof kit.default !== "boolean")
      errors.push(`${at}.default must be true or false`);
    if (!Array.isArray(kit.extensions) || kit.extensions.length === 0) {
      errors.push(`${at}.extensions must be a non-empty array`);
      return;
    }
    if (kit.extensions.length > LIMITS.extensionsPerKit)
      errors.push(`${at} has at most ${LIMITS.extensionsPerKit} extensions (found ${kit.extensions.length})`);

    const repos = new Set();
    kit.extensions.forEach((ext, j) => {
      const eat = `${at}.extensions[${j}]`;
      if (!isObject(ext)) {
        errors.push(`${eat} must be an object`);
        return;
      }
      const repo = lc(ext.repo);
      if (!REPO.test(repo)) errors.push(`${eat}.repo must be "owner/repo"`);
      else {
        if (repos.has(repo)) errors.push(`${eat}.repo ${repo} is listed twice in this kit`);
        repos.add(repo);
        if (!okVerified.has(repo)) errors.push(`${eat}.repo ${repo} is not in verified.json`);
        if (!okRegistry.has(repo)) errors.push(`${eat}.repo ${repo} is not in registry.json`);
        if (banned(bannedList, repo)) errors.push(`${eat}.repo ${repo} is banned`);
      }
      checkText(errors, `${eat}.name`, ext.name, 1, LIMITS.extensionName);
      checkText(errors, `${eat}.summary`, ext.summary ?? "", 0, LIMITS.extensionSummary);
      if (
        ext.minAppVersion !== undefined &&
        !(typeof ext.minAppVersion === "string" && VERSION.test(ext.minAppVersion))
      )
        errors.push(`${eat}.minAppVersion must be x.y.z`);
    });
  });
  return errors;
}

const readJson = (name) =>
  JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = validateKits(readJson("./kits.json"), {
    verified: readJson("./verified.json"),
    registry: readJson("./registry.json"),
    banned: readJson("./banned.json"),
  });
  if (errors.length > 0) {
    console.error(`kits.json has ${errors.length} problem(s):\n${errors.map((e) => `- ${e}`).join("\n")}`);
    process.exit(1);
  }
  console.log("kits.json is valid");
}
