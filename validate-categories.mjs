// Checks categories.json (the Extensions store's category vocabulary) and
// category-overrides.json (categories the registry gives untagged repos) with
// the parser build-registry.mjs uses, so a bad edit fails here instead of in
// the hourly build. CI runs it on every change; locally:
// `node validate-categories.mjs [categories.json] [category-overrides.json]`.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCategories, parseOverrides } from "./store-fields.mjs";

/** Every problem in the two files; overrides are checked once the vocabulary is valid. */
export function validateStoreConfig(categoriesDoc, overridesDoc) {
  const { vocabulary, errors } = parseCategories(categoriesDoc);
  if (!vocabulary) return errors.map((e) => `categories.json: ${e}`);
  return parseOverrides(overridesDoc, vocabulary).errors.map((e) => `category-overrides.json: ${e}`);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [
    categoriesFile = path.join(here, "categories.json"),
    overridesFile = path.join(here, "category-overrides.json"),
  ] = process.argv.slice(2);
  let errors;
  try {
    errors = validateStoreConfig(readJson(categoriesFile), readJson(overridesFile));
  } catch (e) {
    errors = [e instanceof Error ? e.message : String(e)];
  }
  if (errors.length > 0) {
    console.error(`${errors.length} problem(s):\n${errors.map((e) => `- ${e}`).join("\n")}`);
    process.exit(1);
  }
  console.log("categories.json and category-overrides.json are valid");
}
