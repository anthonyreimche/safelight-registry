#!/usr/bin/env node
// Build registry.json — the static catalog the SafeLight Extensions store loads.
//
// This does, ONCE and server-side (in CI), exactly what the app used to do on
// every machine on every store open: discover every published extension, gather
// its metadata, and resolve its store thumbnail (manifest icon → custom social
// preview → owner avatar). The app then fetches the committed registry.json from
// jsDelivr — one CDN request, no GitHub API rate limit, the COMPLETE catalog with
// thumbnails already baked. That is what makes the store load fast.
//
// No dependencies: Node 20+ global fetch only. Auth via GITHUB_TOKEN (the Actions
// token) lifts the search/REST budget to 5000/hr so a full rebuild is comfortable
// even as the catalog grows. Run locally with a PAT in GITHUB_TOKEN to preview.
//
// registry.json is generated — DO NOT edit it by hand; edit this script instead.
//
// Output shape (consumed by SafeLight electron/main.cjs → normalizeRegistryEntry
// and electron/plugin-releases.cjs → parseRegistryVersions):
//   { schemaVersion, generatedAt, topic, count,
//     categories: [{ slug, label, description }], types: [{ slug, label }],
//     extensions: [
//       { fullName, description, stars, createdAt, updatedAt, topics,
//         avatarUrl, thumbnail: { url, custom }, name?,
//         categories: [slug], type: slug | null, keywords: [string],
//         screenshots: [url], worksWith: ["owner/repo"],
//         latest?: { version, from: "release", tag, zips, minAppVersion? }
//                | { version, from: "branch", minAppVersion? },
//         prerelease?: { version, from: "release", tag, zips, minAppVersion? },
//         releaseError?: string }, … ] }
//
// The store fields come from categories.json, category-overrides.json and
// each repo's HEAD safelight.json; see store-fields.mjs.

import { writeFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  cleanKeywords,
  cleanName,
  cleanScreenshots,
  declaredWorksWith,
  linkWorksWith,
  parseCategories,
  parseOverrides,
  publicVocabulary,
  resolveAssetUrl,
  resolveCategories,
  resolveType,
} from "./store-fields.mjs";

const TOPIC = process.env.SAFELIGHT_TOPIC || "safelight-extension";
const TOKEN = process.env.GITHUB_TOKEN || "";
const OUT = process.env.REGISTRY_OUT || "registry.json";
const BANNED_FILE = process.env.BANNED_FILE || "banned.json";
const VERIFIED_FILE = process.env.VERIFIED_FILE || "verified.json";
const CATEGORIES_FILE = process.env.CATEGORIES_FILE || "categories.json";
const OVERRIDES_FILE = process.env.OVERRIDES_FILE || "category-overrides.json";
const MAX_PAGES = 10; // 10 × 100 = up to 1000 extensions; raise if ever needed
const CONCURRENCY = 8; // parallel thumbnail resolutions

const apiHeaders = (extra = {}) => ({
  "User-Agent": "safelight-registry-builder",
  Accept: "application/vnd.github+json",
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
  ...extra,
});

async function fetchWithTimeout(url, opts, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Banned kill-switch ────────────────────────────────────────────────────────
// Exclude banned repos/owners from the catalog at build time (defence in depth —
// the app still enforces the live banned.json independently). Missing file = no
// bans, which is fine. Matches banned.json's { repos, owners } shape.
async function loadBanned() {
  const repos = new Set();
  const owners = new Set();
  try {
    const raw = JSON.parse(await readFile(BANNED_FILE, "utf8"));
    for (const r of raw?.repos ?? []) repos.add(String(r).trim().toLowerCase());
    for (const o of raw?.owners ?? []) owners.add(String(o).trim().toLowerCase());
  } catch {
    // No banned.json (or unreadable) → nothing to exclude.
  }
  return { repos, owners };
}

function isBanned(fullName, banned) {
  const lc = fullName.toLowerCase();
  return banned.repos.has(lc) || banned.owners.has(lc.split("/")[0]);
}

// ── Store grouping ────────────────────────────────────────────────────────────
// The vocabulary must parse: a build that can't read it stops here rather
// than publish an index without categories. No overrides file is no overrides.
export async function loadStoreConfig(categoriesFile = CATEGORIES_FILE, overridesFile = OVERRIDES_FILE) {
  const { vocabulary, errors } = parseCategories(JSON.parse(await readFile(categoriesFile, "utf8")));
  if (!vocabulary) throw new Error(`${categoriesFile}: ${errors.join("; ")}`);
  let overridesDoc;
  try {
    overridesDoc = JSON.parse(await readFile(overridesFile, "utf8"));
  } catch (e) {
    if (e?.code === "ENOENT") return { vocabulary, overrides: new Map() };
    throw e;
  }
  const { overrides, errors: overrideErrors } = parseOverrides(overridesDoc, vocabulary);
  if (overrideErrors.length) throw new Error(`${overridesFile}: ${overrideErrors.join("; ")}`);
  return { vocabulary, overrides };
}

// Reverse Works with links need the verified list; missing means none verified.
// A file that exists but can't be read costs those links, not the build.
export async function loadVerified(file = VERIFIED_FILE) {
  try {
    const raw = JSON.parse(await readFile(file, "utf8"));
    return new Set(
      (raw?.verified ?? []).map((e) => String(typeof e === "string" ? e : e?.repo ?? "").trim().toLowerCase()),
    );
  } catch (e) {
    if (e?.code !== "ENOENT") console.error(`${file}: could not be read, no reverse Works with links: ${e?.message || e}`);
    return new Set();
  }
}

const list = (v) => (Array.isArray(v) ? v : []);

/** One repo's store fields. When GitHub couldn't give us the manifest, the
 *  previous build's manifest-derived fields stand in until a readable build;
 *  the type comes from topics, so it is always current. A previous entry from
 *  before these fields existed has nothing to keep, so it reads as no manifest. */
export function entryStoreFields(fullName, topics, manifest, previous, { vocabulary, overrides }) {
  const type = resolveType(topics, vocabulary);
  if (manifest === UNREADABLE && Array.isArray(previous?.categories)) {
    const known = new Set(vocabulary.categories.map((c) => c.slug));
    return {
      fields: {
        ...(typeof previous.name === "string" ? { name: previous.name } : {}),
        categories: list(previous.categories).filter((s) => known.has(s)),
        type,
        keywords: list(previous.keywords),
        screenshots: list(previous.screenshots),
      },
      declared: list(previous.worksWith),
      ignored: [],
    };
  }
  const readable = manifest === UNREADABLE ? null : manifest;
  const { categories, ignored } = resolveCategories({
    manifest: readable,
    topics,
    override: overrides.get(fullName.toLowerCase()),
    vocabulary,
  });
  const name = cleanName(readable);
  return {
    fields: {
      ...(name ? { name } : {}),
      categories,
      type,
      keywords: cleanKeywords(readable),
      screenshots: cleanScreenshots(fullName, readable),
    },
    declared: declaredWorksWith(fullName, readable),
    ignored,
  };
}

/** The published catalog: the public vocabulary, then every entry with its
 *  Works with links made two-way across the whole list. */
export function catalogPayload({ extensions, declared, vocabulary, isVerified, isBanned, topic, generatedAt }) {
  const links = linkWorksWith(extensions, declared, { isVerified, isBanned });
  return {
    schemaVersion: 1,
    generatedAt,
    topic,
    count: extensions.length,
    ...publicVocabulary(vocabulary),
    extensions: extensions.map((e) => ({ ...e, worksWith: links.get(e.fullName.toLowerCase()) ?? [] })),
  };
}

// ── Discovery ─────────────────────────────────────────────────────────────────
// Page through the GitHub Search API for `topic:<TOPIC>` until exhausted. Unlike
// the old in-app single page of 25, this collects the whole catalog.
async function searchAll() {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url =
      `https://api.github.com/search/repositories` +
      `?q=${encodeURIComponent(`topic:${TOPIC}`)}` +
      `&sort=stars&order=desc&per_page=100&page=${page}`;
    const res = await fetchWithTimeout(url, { headers: apiHeaders() });
    if (res.status === 403 || res.status === 429) {
      const reset = res.headers.get("x-ratelimit-reset");
      throw new Error(`GitHub rate limit hit on page ${page} (reset ${reset})`);
    }
    if (!res.ok) throw new Error(`search page ${page}: ${res.status}`);
    const body = await res.json();
    const items = body.items ?? [];
    out.push(...items);
    if (items.length < 100) break; // last page
    if (out.length >= (body.total_count ?? out.length)) break;
  }
  return out;
}

// ── Thumbnail resolution (mirrors SafeLight's electron/main.cjs resolveThumbnail) ──
function avatarFor(repo, avatarUrl) {
  if (avatarUrl) return avatarUrl;
  return `https://github.com/${repo.split("/")[0]}.png?size=120`;
}

const isAutoOgCard = (url) =>
  typeof url === "string" &&
  url.startsWith("https://opengraph.githubassets.com/");

// The repo's default-branch safelight.json, read once per build for the store
// icon and, for repos without releases, the version. Resolves to the parsed
// manifest; to null when the repo has none (a 404, or a body that isn't JSON);
// or to UNREADABLE when GitHub couldn't be read (other statuses, network
// errors, a timeout, a stalled body). UNREADABLE has no icon, so the thumbnail
// falls through to the og card or the avatar.
export const UNREADABLE = Symbol("unreadable");

export async function fetchHeadManifest(repo, ms = 6000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/safelight.json`, {
      headers: { "User-Agent": "safelight-registry-builder", Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (res.status === 404) return null;
    if (!res.ok) return UNREADABLE;
    const text = await res.text(); // inside the timer, so a stalled body times out too
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch {
    return UNREADABLE;
  } finally {
    clearTimeout(timer);
  }
}

// The extension's manifest-declared store icon, resolved to a CDN URL, or null.
export function iconFromManifest(repo, manifest) {
  return resolveAssetUrl(repo, manifest?.icon);
}

// The repo's custom uploaded social preview (og:image), or null when GitHub only
// has its auto-generated card. Same <head> scrape the app used to do per card.
async function fetchOgImage(repo) {
  try {
    const res = await fetchWithTimeout(
      `https://github.com/${repo}`,
      { headers: { "User-Agent": "safelight-registry-builder", Accept: "text/html" } },
      8000,
    );
    if (!res.ok || !res.body) return null;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    while (html.length < 48000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (/property=["']og:image["']/i.test(html)) break;
    }
    try {
      await reader.cancel();
    } catch {}
    const m =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (m && /^https:\/\//i.test(m[1]) && !isAutoOgCard(m[1])) return m[1];
    return null;
  } catch {
    return null;
  }
}

async function resolveThumbnail(repo, avatarUrl, manifest) {
  const icon = iconFromManifest(repo, manifest);
  if (icon) return { url: icon, custom: true };
  const og = await fetchOgImage(repo);
  if (og) return { url: og, custom: true };
  return { url: avatarFor(repo, avatarUrl), custom: false };
}

// ── Versions ──────────────────────────────────────────────────────────────────
// What the app's update check reads instead of calling the GitHub API itself:
// each extension's newest release (and a newer pre-release), or its branch
// version when it publishes no releases. The rules mirror SafeLight's
// electron/plugin-releases.cjs; keep the two in step.

const VERSION_RE = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/;
const stripV = (tag) => String(tag).replace(/^v/i, "");
const isSemver = (tag) => VERSION_RE.test(stripV(tag));
const ZIP_CAP = 3;
const CANDIDATES = 5;

function parseSemver(tag) {
  const m = stripV(tag).match(VERSION_RE);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 10) || 0, m[2] ? parseInt(m[2], 10) || 0 : 0, m[3] ? parseInt(m[3], 10) || 0 : 0];
}

function parsePrerelease(tag) {
  const m = String(tag).match(/^v?[\d.]+-([0-9A-Za-z.-]+)/i);
  return m ? m[1] : null;
}

function comparePrerelease(a, b) {
  const xs = a.split(".");
  const ys = b.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const x = xs[i];
    const y = ys[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) > Number(y) ? 1 : -1;
    } else if (xn !== yn) {
      return yn ? 1 : -1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

export function compareSemver(a, b) {
  const x = parseSemver(a);
  const y = parseSemver(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  const xp = parsePrerelease(a);
  const yp = parsePrerelease(b);
  if (xp === null && yp === null) return 0;
  if (xp === null) return 1;
  if (yp === null) return -1;
  return comparePrerelease(xp, yp);
}

/** Published releases with version tags, newest version first, each with up
 *  to three of the repo's own .zip downloads. */
export function eligibleReleases(payload, repo) {
  if (!Array.isArray(payload)) return [];
  const prefix = `https://github.com/${repo}/releases/download/`.toLowerCase();
  return payload
    .filter((r) => r && !r.draft && typeof r.tag_name === "string" && isSemver(r.tag_name))
    .map((r) => ({
      version: stripV(r.tag_name),
      tag: r.tag_name,
      prerelease: !!r.prerelease || parsePrerelease(r.tag_name) !== null,
      zips: (Array.isArray(r.assets) ? r.assets : [])
        .filter(
          (a) =>
            a &&
            typeof a.name === "string" &&
            /\.zip$/i.test(a.name) &&
            typeof a.browser_download_url === "string" &&
            a.browser_download_url.toLowerCase().startsWith(prefix),
        )
        .slice(0, ZIP_CAP)
        .map((a) => a.browser_download_url),
    }))
    .sort((a, b) => compareSemver(b.version, a.version));
}

// The first candidate whose safelight.json at the tag agrees with it (a
// missing manifest passes; the app checks the download), and the
// disagreements seen on the way.
async function firstAgreeing(candidates, manifestAt) {
  const mismatches = [];
  for (const r of candidates.slice(0, CANDIDATES)) {
    const m = await manifestAt(r.tag);
    if (m && typeof m.version === "string" && compareSemver(m.version, r.version) !== 0) {
      mismatches.push(`${r.tag}: safelight.json says ${m.version}`);
      continue;
    }
    const rec = { version: r.version, tag: r.tag, from: "release", zips: r.zips };
    if (m && typeof m.minAppVersion === "string") rec.minAppVersion = m.minAppVersion;
    return { rec, mismatches };
  }
  return { rec: null, mismatches };
}

/** Registry fields for a repo's releases: { latest, prerelease? };
 *  { releaseError } when no full release agrees with its manifest; {} when it
 *  has only pre-releases (the app then asks GitHub itself); null when it has
 *  no releases (the caller records the branch version). */
export async function releaseFields(payload, repo, manifestAt) {
  const list = eligibleReleases(payload, repo);
  if (list.length === 0) return null;
  const full = list.filter((r) => !r.prerelease);
  const { rec: latest, mismatches } = await firstAgreeing(full, manifestAt);
  if (!latest) return full.length ? { releaseError: mismatches[0] ?? "no usable release" } : {};
  const newer = list.filter((r) => r.prerelease && compareSemver(r.version, latest.version) > 0);
  const { rec: prerelease } = await firstAgreeing(newer, manifestAt);
  return prerelease ? { latest, prerelease } : { latest };
}

/** Registry fields for a repo that publishes from its default branch. */
export function branchFields(manifest) {
  if (!manifest || typeof manifest.version !== "string" || !isSemver(manifest.version)) return {};
  const latest = { version: manifest.version, from: "branch" };
  if (typeof manifest.minAppVersion === "string") latest.minAppVersion = manifest.minAppVersion;
  return { latest };
}

/** A repo with no releases: its branch record when the default-branch manifest
 *  was read, {} when it has none, and the previous build's fields when GitHub
 *  could not be read. */
export function branchOrPrevious(manifest, previous) {
  return manifest === UNREADABLE ? pickVersionFields(previous) : branchFields(manifest);
}

/** The version fields of a previous build's entry. */
export function pickVersionFields(entry) {
  const out = {};
  for (const k of ["latest", "prerelease", "releaseError"])
    if (entry && entry[k] !== undefined) out[k] = entry[k];
  return out;
}

/** True when two catalogs differ only in generatedAt. */
export function sameCatalog(a, b) {
  if (!a || !b) return false;
  const body = (p) => JSON.stringify({ ...p, generatedAt: null });
  return body(a) === body(b);
}

async function fetchReleases(repo) {
  const res = await fetchWithTimeout(
    `https://api.github.com/repos/${repo}/releases?per_page=30`,
    { headers: apiHeaders() },
  );
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`releases ${repo}: ${res.status}`);
  return res.json();
}

async function fetchManifestAt(repo, ref) {
  const res = await fetchWithTimeout(
    `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/safelight.json`,
    { headers: { "User-Agent": "safelight-registry-builder", Accept: "application/json" } },
    6000,
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`manifest ${repo}@${ref}: ${res.status}`);
  try {
    return await res.json();
  } catch {
    return null;
  }
}

// One repo's version fields. Any failure keeps what the previous build
// recorded, so a GitHub hiccup never drops an extension's update record.
async function versionFields(repo, manifest, previous) {
  try {
    const fields = await releaseFields(await fetchReleases(repo), repo, (tag) => fetchManifestAt(repo, tag));
    return fields ?? branchOrPrevious(manifest, previous);
  } catch (e) {
    console.error(`versions for ${repo} kept from the last build: ${e?.message || e}`);
    return pickVersionFields(previous);
  }
}

async function readPrevious() {
  try {
    return JSON.parse(await readFile(OUT, "utf8"));
  } catch {
    return null;
  }
}

// Bounded-concurrency map so we don't open hundreds of sockets at once.
async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function main() {
  const previous = await readPrevious();
  const before = new Map(
    (previous?.extensions ?? []).map((e) => [String(e.fullName).toLowerCase(), e]),
  );
  const banned = await loadBanned();
  const storeConfig = await loadStoreConfig();
  const verified = await loadVerified();
  const declared = new Map();
  const repos = (await searchAll()).filter(
    (r) => r.full_name && !isBanned(r.full_name, banned),
  );
  console.error(`Found ${repos.length} extension repo(s) for topic:${TOPIC}`);

  const extensions = await mapPool(repos, CONCURRENCY, async (r) => {
    const avatarUrl = r.owner?.avatar_url ?? null;
    const manifest = await fetchHeadManifest(r.full_name);
    const thumbnail = await resolveThumbnail(r.full_name, avatarUrl, manifest);
    const topics = Array.isArray(r.topics) ? r.topics : [];
    const previous = before.get(r.full_name.toLowerCase());
    const own = entryStoreFields(r.full_name, topics, manifest, previous, storeConfig);
    if (own.ignored.length)
      console.error(`${r.full_name}: manifest categories not in categories.json: ${own.ignored.join(", ")}`);
    declared.set(r.full_name.toLowerCase(), own.declared);
    return {
      fullName: r.full_name,
      description: r.description ?? null,
      stars: r.stargazers_count ?? 0,
      createdAt: r.created_at ?? null,
      updatedAt: r.updated_at ?? null,
      topics,
      avatarUrl,
      thumbnail,
      ...own.fields,
      worksWith: [],
      ...(await versionFields(r.full_name, manifest, previous)),
    };
  });

  // Stable default order: most-starred first, then by name, so equal-star repos
  // don't reorder between builds (the app re-sorts per shelf anyway).
  extensions.sort((a, b) => b.stars - a.stars || a.fullName.localeCompare(b.fullName));

  const listed = new Set(extensions.map((e) => e.fullName.toLowerCase()));
  for (const [from, targets] of declared)
    for (const t of targets)
      if (!listed.has(t.toLowerCase())) console.error(`${from}: worksWith ${t} is not in the catalog`);

  const payload = catalogPayload({
    extensions,
    declared,
    vocabulary: storeConfig.vocabulary,
    isVerified: (repo) => verified.has(repo),
    isBanned: (repo) => isBanned(repo, banned),
    topic: TOPIC,
    generatedAt: new Date().toISOString(),
  });
  if (sameCatalog(previous, payload)) {
    console.error(`${OUT} unchanged (${extensions.length} extensions)`);
    return;
  }
  await writeFile(OUT, JSON.stringify(payload, null, 2) + "\n");
  console.error(`Wrote ${OUT} (${extensions.length} extensions)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error("build-registry failed:", e?.message || e);
    process.exit(1);
  });
}
