// Tests for store-fields.mjs. Run: node --test store-fields.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { LIMITS, cleanKeywords, cleanScreenshots, declaredWorksWith, linkWorksWith, parseCategories, parseOverrides, publicVocabulary, resolveAssetUrl, resolveCategories, resolveType } from "./store-fields.mjs";

const committed = (name) => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8"));

const cat = (slug, label, extra = {}) => ({ slug, label, description: `${label}.`, ...extra });
const TYPES = [
  { slug: "module", label: "Module" },
  { slug: "pipeline", label: "Processing" },
  { slug: "panel", label: "Panel" },
];
const vocabDoc = (categories, types = TYPES) => ({ schema: 1, categories, types });
const BASE = [
  cat("library", "Library"),
  cat("color", "Colour"),
  cat("look", "Looks"),
  cat("theme", "Themes and interface", { aliases: ["Themes", "Interface"] }),
];
const errorsOf = (doc) => parseCategories(doc).errors.join("\n");

test("a valid vocabulary parses, with missing aliases as []", () => {
  const { vocabulary, errors } = parseCategories(vocabDoc(BASE));
  assert.deepEqual(errors, []);
  assert.deepEqual(vocabulary.categories[0], { slug: "library", label: "Library", description: "Library.", aliases: [] });
  assert.deepEqual(vocabulary.categories[3].aliases, ["Themes", "Interface"]);
  assert.deepEqual(vocabulary.types, TYPES);
});

test("the committed categories.json is valid, with unique slugs", () => {
  const { vocabulary, errors } = parseCategories(committed("categories.json"));
  assert.deepEqual(errors, []);
  const slugs = vocabulary.categories.map((c) => c.slug);
  assert.ok(slugs.length > 0);
  assert.equal(new Set(slugs).size, slugs.length);
});

test("rejects a non-object, a wrong schema and an empty category list", () => {
  assert.match(errorsOf([]), /categories\.json must be an object/);
  assert.match(errorsOf({ ...vocabDoc(BASE), schema: 2 }), /schema must be 1/);
  assert.match(errorsOf(vocabDoc([])), /categories must be a non-empty array/);
  assert.equal(parseCategories(vocabDoc([])).vocabulary, null);
});

test("rejects bad, reserved and duplicate slugs", () => {
  assert.match(errorsOf(vocabDoc([cat("Tone!", "Tone")])), /categories\[0\]\.slug must match/);
  assert.match(errorsOf(vocabDoc([cat("other", "Misc")])), /categories\[0\]\.slug "other" is reserved by the store/);
  assert.match(errorsOf(vocabDoc([cat("home", "Home")])), /categories\[0\]\.slug "home" is reserved by the store/);
  assert.match(errorsOf(vocabDoc([cat("tone", "Tone"), cat("tone", "Tones")])), /categories\[1\]\.slug "tone" is a duplicate/);
});

test("rejects empty and over-long text", () => {
  assert.match(errorsOf(vocabDoc([cat("tone", " ")])), /categories\[0\]\.label must not be empty/);
  assert.match(errorsOf(vocabDoc([cat("tone", "x".repeat(LIMITS.label + 1))])), /label is 25 characters; the limit is 24/);
  assert.match(errorsOf(vocabDoc([cat("tone", "Tone", { description: "" })])), /description must not be empty/);
  assert.match(
    errorsOf(vocabDoc([cat("tone", "Tone", { description: "x".repeat(LIMITS.description + 1) })])),
    /description is 141 characters; the limit is 140/,
  );
});

test("rejects aliases that aren't non-empty strings", () => {
  assert.match(errorsOf(vocabDoc([cat("tone", "Tone", { aliases: "Tones" })])), /aliases must be an array of non-empty strings/);
  assert.match(errorsOf(vocabDoc([cat("tone", "Tone", { aliases: [""] })])), /aliases must be an array of non-empty strings/);
});

test("every name stands for one category", () => {
  assert.match(
    errorsOf(vocabDoc([cat("library", "Library"), cat("organise", "library")])),
    /categories\[1\]\.label "library" clashes with categories\[0\]/,
  );
  assert.match(
    errorsOf(vocabDoc([cat("color", "Colour", { aliases: ["Color"] })])),
    /categories\[0\]\.aliases\[0\] "Color" matches a slug or label/,
  );
  assert.match(
    errorsOf(vocabDoc([cat("look", "Looks", { aliases: ["Film"] }), cat("tone", "Tone", { aliases: ["film"] })])),
    /categories\[1\]\.aliases\[0\] "film" repeats another alias/,
  );
});

test("rejects more than 16 categories", () => {
  const many = Array.from({ length: LIMITS.categories + 1 }, (_, i) => cat(`c${i}`, `Category ${i}`));
  assert.match(errorsOf(vocabDoc(many)), /at most 16 categories \(found 17\)/);
});

test("checks types", () => {
  assert.match(errorsOf({ schema: 1, categories: BASE }), /types must be an array/);
  assert.match(errorsOf(vocabDoc(BASE, [{ slug: "Panel", label: "Panel" }])), /types\[0\]\.slug must match/);
  assert.match(
    errorsOf(vocabDoc(BASE, [{ slug: "panel", label: "Panel" }, { slug: "panel", label: "Panels" }])),
    /types\[1\]\.slug "panel" is a duplicate/,
  );
  assert.match(errorsOf(vocabDoc(BASE, [{ slug: "theme", label: "Theme" }])), /types\[0\]\.slug "theme" is also a category slug/);
  assert.match(errorsOf(vocabDoc(BASE, [{ slug: "panel", label: "" }])), /types\[0\]\.label must not be empty/);
});

const VOCAB = parseCategories(vocabDoc(BASE)).vocabulary;
const overrideErrors = (doc) => parseOverrides(doc, VOCAB).errors.join("\n");

test("overrides map lowercased repos to known slugs", () => {
  const { overrides, errors } = parseOverrides({ schema: 1, repos: { "Acme/Watermark": ["look", "color"] } }, VOCAB);
  assert.deepEqual(errors, []);
  assert.deepEqual([...overrides], [["acme/watermark", ["look", "color"]]]);
});

test("the committed overrides are valid against the committed vocabulary", () => {
  const { vocabulary } = parseCategories(committed("categories.json"));
  assert.deepEqual(parseOverrides(committed("category-overrides.json"), vocabulary).errors, []);
});

test("rejects malformed overrides", () => {
  assert.match(overrideErrors([]), /category-overrides\.json must be an object/);
  assert.match(overrideErrors({ schema: 2, repos: {} }), /schema must be 1/);
  assert.match(overrideErrors({ schema: 1, repos: [] }), /repos must be an object/);
  assert.match(overrideErrors({ schema: 1, repos: { acme: ["look"] } }), /repos\["acme"\] must be "owner\/repo"/);
  assert.match(
    overrideErrors({ schema: 1, repos: { "acme/one": ["look"], "Acme/One": ["color"] } }),
    /repos\["Acme\/One"\] repeats another repo/,
  );
  assert.match(overrideErrors({ schema: 1, repos: { "acme/one": [] } }), /repos\["acme\/one"\] must be a non-empty array/);
  assert.match(
    overrideErrors({ schema: 1, repos: { "acme/one": ["look", "color", "library", "theme"] } }),
    /repos\["acme\/one"\] has 4 categories; the limit is 3/,
  );
  assert.match(overrideErrors({ schema: 1, repos: { "acme/one": ["tone"] } }), /repos\["acme\/one"\] names unknown category "tone"/);
});

test("an override that repeats a category is an error, and the stored list has it once", () => {
  const doc = { schema: 1, repos: { "acme/one": ["look", "look", "color"] } };
  assert.match(overrideErrors(doc), /repos\["acme\/one"\] repeats category "look"/);
  assert.deepEqual(parseOverrides(doc, VOCAB).overrides.get("acme/one"), ["look", "color"]);
});

test("the public vocabulary has no aliases", () => {
  const pub = publicVocabulary(VOCAB);
  assert.deepEqual(pub.categories[3], { slug: "theme", label: "Themes and interface", description: "Themes and interface." });
  assert.deepEqual(pub.types, TYPES);
});

// ── Per-repo fields ──

const resolve = (manifest, topics = [], override) =>
  resolveCategories({ manifest, topics, override, vocabulary: VOCAB });

test("manifest categories match by slug, label or alias, any case, in manifest order", () => {
  assert.deepEqual(resolve({ categories: ["themes", "Colour", "LOOK"] }), {
    categories: ["theme", "color", "look"],
    ignored: [],
  });
  assert.deepEqual(resolve({ categories: [" Interface "] }).categories, ["theme"]);
});

test("manifest categories win over topics, dedupe, and cap at three", () => {
  assert.deepEqual(
    resolve({ categories: ["Looks", "look", "Colour", "Library", "Themes"] }, ["safelight-theme"]).categories,
    ["look", "color", "library"],
  );
});

test("unknown manifest values are ignored and reported; all-unknown falls back to topics", () => {
  assert.deepEqual(resolve({ categories: ["Develop", "Panels"] }, ["safelight-color"]), {
    categories: ["color"],
    ignored: ["Develop", "Panels"],
  });
  assert.deepEqual(resolve({ categories: ["Develop", "Colour"] }).ignored, ["Develop"]);
});

test("non-array or non-string manifest categories are ignored", () => {
  assert.deepEqual(resolve({ categories: "Colour" }, ["safelight-look"]).categories, ["look"]);
  assert.deepEqual(resolve({ categories: [42, null] }, ["safelight-look"]), { categories: ["look"], ignored: [] });
  assert.deepEqual(resolve(null, ["safelight-look"]).categories, ["look"]);
});

test("topics resolve in vocabulary order, whatever their own order", () => {
  assert.deepEqual(
    resolve(null, ["safelight-theme", "safelight-panel", "safelight-color", "safelight-library", "safelight-look"]).categories,
    ["library", "color", "look"],
  );
});

test("the override applies only when manifest and topics give nothing", () => {
  assert.deepEqual(resolve(null, ["safelight-panel"], ["look"]).categories, ["look"]);
  assert.deepEqual(resolve(null, ["safelight-color"], ["look"]).categories, ["color"]);
  assert.deepEqual(resolve({ categories: ["Library"] }, [], ["look"]).categories, ["library"]);
});

test("nothing anywhere is no categories", () => {
  assert.deepEqual(resolve(null, ["safelight-extension"]), { categories: [], ignored: [] });
});

test("the type follows the vocabulary's precedence", () => {
  assert.equal(resolveType(["safelight-panel", "safelight-pipeline"], VOCAB), "pipeline");
  assert.equal(resolveType(["safelight-panel", "safelight-module"], VOCAB), "module");
  assert.equal(resolveType(["safelight-panel"], VOCAB), "panel");
  assert.equal(resolveType(["safelight-theme"], VOCAB), null);
  assert.equal(resolveType(undefined, VOCAB), null);
});

test("keywords are trimmed, lowercased, deduped and capped", () => {
  assert.deepEqual(cleanKeywords({ keywords: [" Moiré ", "moiré", "B&W", 7, "", "x".repeat(41)] }), ["moiré", "b&w"]);
  const many = Array.from({ length: LIMITS.keywords + 5 }, (_, i) => `k${i}`);
  assert.equal(cleanKeywords({ keywords: many }).length, LIMITS.keywords);
  assert.deepEqual(cleanKeywords(null), []);
  assert.deepEqual(cleanKeywords({ keywords: "map" }), []);
});

test("asset URLs: https kept, repo-relative to jsDelivr, the rest refused", () => {
  assert.equal(resolveAssetUrl("acme/one", "https://example.com/a.png"), "https://example.com/a.png");
  assert.equal(resolveAssetUrl("acme/one", "./docs/a.png"), "https://cdn.jsdelivr.net/gh/acme/one/docs/a.png");
  assert.equal(resolveAssetUrl("acme/one", "docs/a.png"), "https://cdn.jsdelivr.net/gh/acme/one/docs/a.png");
  assert.equal(resolveAssetUrl("acme/one", "/etc/a.png"), null);
  assert.equal(resolveAssetUrl("acme/one", "../other/a.png"), null);
  assert.equal(resolveAssetUrl("acme/one", "http://example.com/a.png"), null);
  assert.equal(resolveAssetUrl("acme/one", "data:image/png;base64,AAAA"), null);
  assert.equal(resolveAssetUrl("acme/one", ""), null);
  assert.equal(resolveAssetUrl("acme/one", 5), null);
});

test("asset URLs longer than the cap are refused, whatever their kind", () => {
  const room = LIMITS.assetUrl - "https://example.com/".length;
  const atCap = `https://example.com/${"a".repeat(room)}`;
  assert.equal(atCap.length, LIMITS.assetUrl);
  assert.equal(resolveAssetUrl("acme/one", atCap), atCap);
  assert.equal(resolveAssetUrl("acme/one", `${atCap}a`), null);
  assert.equal(resolveAssetUrl("acme/one", `docs/${"a".repeat(LIMITS.assetUrl)}.png`), null);
  assert.equal(resolveAssetUrl("acme/one", `  ${atCap}  `), atCap);
  assert.deepEqual(cleanScreenshots("acme/one", { screenshots: [`${atCap}a`, "ok.png"] }), [
    "https://cdn.jsdelivr.net/gh/acme/one/ok.png",
  ]);
});

test("screenshots resolve like the icon, deduped, at most six", () => {
  assert.deepEqual(cleanScreenshots("acme/one", { screenshots: ["a.png", "./a.png", "/x.png", "https://e.com/b.png"] }), [
    "https://cdn.jsdelivr.net/gh/acme/one/a.png",
    "https://e.com/b.png",
  ]);
  const many = Array.from({ length: 9 }, (_, i) => `s${i}.png`);
  assert.equal(cleanScreenshots("acme/one", { screenshots: many }).length, LIMITS.screenshots);
  assert.deepEqual(cleanScreenshots("acme/one", null), []);
});

test("declared worksWith keeps valid repos, drops self and repeats, caps at six", () => {
  assert.deepEqual(
    declaredWorksWith("Acme/Map", { worksWith: ["acme/gps", "ACME/GPS", "acme/map", "not a repo", 3, " acme/scopes "] }),
    ["acme/gps", "acme/scopes"],
  );
  const many = Array.from({ length: 9 }, (_, i) => `acme/r${i}`);
  assert.equal(declaredWorksWith("acme/map", { worksWith: many }).length, LIMITS.worksWith);
  assert.deepEqual(declaredWorksWith("acme/map", null), []);
});

const catalog = ["Acme/Map", "acme/gps", "acme/scopes", "other/tool"].map((fullName) => ({ fullName }));
const verifiedSet = new Set(["acme/gps"]);
const link = (declared, banned = new Set()) =>
  linkWorksWith(catalog, new Map(Object.entries(declared)), {
    isVerified: (r) => verifiedSet.has(r),
    isBanned: (r) => banned.has(r),
  });

test("a verified declarer links both ways, in catalog casing", () => {
  const links = link({ "acme/gps": ["acme/map"] });
  assert.deepEqual(links.get("acme/gps"), ["Acme/Map"]);
  assert.deepEqual(links.get("acme/map"), ["acme/gps"]);
  assert.deepEqual(links.get("acme/scopes"), []);
});

test("an unverified declarer links only from its own page", () => {
  const links = link({ "other/tool": ["acme/map"] });
  assert.deepEqual(links.get("other/tool"), ["Acme/Map"]);
  assert.deepEqual(links.get("acme/map"), []);
});

test("targets outside the catalog, banned repos and self are dropped", () => {
  const links = link({ "acme/gps": ["acme/missing", "acme/scopes", "acme/gps"] }, new Set(["acme/scopes"]));
  assert.deepEqual(links.get("acme/gps"), []);
  assert.deepEqual(link({ "acme/gps": ["acme/map"] }, new Set(["acme/gps"])).get("acme/map"), []);
});

test("declared links come first, then reverse links, each in catalog order, at most six", () => {
  const links = link({ "acme/map": ["other/tool", "acme/scopes"], "acme/gps": ["acme/map"] });
  assert.deepEqual(links.get("acme/map"), ["acme/scopes", "other/tool", "acme/gps"]);
  const big = Array.from({ length: 10 }, (_, i) => ({ fullName: `acme/r${i}` }));
  const capped = linkWorksWith(big, new Map([["acme/r0", big.slice(1).map((e) => e.fullName)]]), {
    isVerified: () => false,
    isBanned: () => false,
  });
  assert.equal(capped.get("acme/r0").length, LIMITS.worksWith);
});
