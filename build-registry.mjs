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
// Output shape (consumed by SafeLight electron/main.cjs → normalizeRegistryEntry):
//   { schemaVersion, generatedAt, topic, count, extensions: [
//       { fullName, description, stars, createdAt, updatedAt, topics,
//         avatarUrl, thumbnail: { url, custom } }, … ] }

import { writeFile, readFile } from "node:fs/promises";

const TOPIC = process.env.SAFELIGHT_TOPIC || "safelight-extension";
const TOKEN = process.env.GITHUB_TOKEN || "";
const OUT = process.env.REGISTRY_OUT || "registry.json";
const BANNED_FILE = process.env.BANNED_FILE || "banned.json";
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

// The extension's manifest-declared store icon, resolved to a CDN URL, or null.
async function fetchIconUrl(repo) {
  try {
    const res = await fetchWithTimeout(
      `https://raw.githubusercontent.com/${repo}/HEAD/safelight.json`,
      { headers: { "User-Agent": "safelight-registry-builder", Accept: "application/json" } },
      6000,
    );
    if (!res.ok) return null;
    const manifest = await res.json();
    const icon = typeof manifest?.icon === "string" ? manifest.icon.trim() : "";
    if (/^https:\/\//i.test(icon)) return icon;
    // Relative path → resolve against the same jsDelivr tree; reject absolute
    // paths and `..` so a manifest can't point outside its own repo.
    if (icon && !icon.startsWith("/") && !icon.includes(".."))
      return `https://cdn.jsdelivr.net/gh/${repo}/${icon.replace(/^\.?\//, "")}`;
    return null;
  } catch {
    return null;
  }
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

async function resolveThumbnail(repo, avatarUrl) {
  const icon = await fetchIconUrl(repo);
  if (icon) return { url: icon, custom: true };
  const og = await fetchOgImage(repo);
  if (og) return { url: og, custom: true };
  return { url: avatarFor(repo, avatarUrl), custom: false };
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
  const banned = await loadBanned();
  const repos = (await searchAll()).filter(
    (r) => r.full_name && !isBanned(r.full_name, banned),
  );
  console.error(`Found ${repos.length} extension repo(s) for topic:${TOPIC}`);

  const extensions = await mapPool(repos, CONCURRENCY, async (r) => {
    const avatarUrl = r.owner?.avatar_url ?? null;
    const thumbnail = await resolveThumbnail(r.full_name, avatarUrl);
    return {
      fullName: r.full_name,
      description: r.description ?? null,
      stars: r.stargazers_count ?? 0,
      createdAt: r.created_at ?? null,
      updatedAt: r.updated_at ?? null,
      topics: Array.isArray(r.topics) ? r.topics : [],
      avatarUrl,
      thumbnail,
    };
  });

  // Stable default order: most-starred first (the app re-sorts per shelf anyway).
  extensions.sort((a, b) => b.stars - a.stars);

  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    topic: TOPIC,
    count: extensions.length,
    extensions,
  };
  await writeFile(OUT, JSON.stringify(payload, null, 2) + "\n");
  console.error(`Wrote ${OUT} (${extensions.length} extensions)`);
}

main().catch((e) => {
  console.error("build-registry failed:", e?.message || e);
  process.exit(1);
});
