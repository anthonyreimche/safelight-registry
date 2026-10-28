// Tests for build-registry.mjs's version records. Run: node --test build-registry.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  UNREADABLE,
  branchFields,
  branchOrPrevious,
  catalogPayload,
  compareSemver,
  eligibleReleases,
  entryStoreFields,
  fetchHeadManifest,
  iconFromManifest,
  loadStoreConfig,
  loadVerified,
  pickVersionFields,
  releaseFields,
  sameCatalog,
} from "./build-registry.mjs";

const REPO = "acme/widget";
const dl = (tag, name) => `https://github.com/${REPO}/releases/download/${tag}/${name}`;
const gh = (tag, over = {}) => ({ tag_name: tag, draft: false, prerelease: false, assets: [], ...over });
const manifests = (map) => async (tag) => (tag in map ? map[tag] : null);

test("latest is the highest full release, with its minAppVersion and zips", async () => {
  const payload = [
    gh("v1.2.0"),
    gh("v1.3.0", {
      assets: [
        { name: "w.zip", browser_download_url: dl("v1.3.0", "w.zip") },
        { name: "notes.txt", browser_download_url: dl("v1.3.0", "notes.txt") },
      ],
    }),
    gh("nightly"),
    gh("v2.0.0", { draft: true }),
  ];
  assert.deepEqual(
    await releaseFields(payload, REPO, manifests({ "v1.3.0": { version: "1.3.0", minAppVersion: "2.6.0" } })),
    {
      latest: { version: "1.3.0", tag: "v1.3.0", from: "release", zips: [dl("v1.3.0", "w.zip")], minAppVersion: "2.6.0" },
    },
  );
});

test("a newer pre-release is recorded beside latest", async () => {
  const payload = [gh("v1.4.0-beta.1"), gh("v1.3.0"), gh("v1.3.0-rc.1", { prerelease: true })];
  assert.deepEqual(await releaseFields(payload, REPO, manifests({})), {
    latest: { version: "1.3.0", tag: "v1.3.0", from: "release", zips: [] },
    prerelease: { version: "1.4.0-beta.1", tag: "v1.4.0-beta.1", from: "release", zips: [] },
  });
});

test("a release whose manifest disagrees is skipped for the next one", async () => {
  const fields = await releaseFields(
    [gh("v1.3.0"), gh("v1.2.0")],
    REPO,
    manifests({ "v1.3.0": { version: "1.2.9" }, "v1.2.0": { version: "1.2.0" } }),
  );
  assert.equal(fields.latest.version, "1.2.0");
});

test("records the disagreement when no full release agrees", async () => {
  assert.deepEqual(
    await releaseFields([gh("v1.3.0")], REPO, manifests({ "v1.3.0": { version: "1.2.0" } })),
    { releaseError: "v1.3.0: safelight.json says 1.2.0" },
  );
});

test("a repo with only pre-releases gets no version fields", async () => {
  assert.deepEqual(await releaseFields([gh("v2.0.0-rc.1")], REPO, manifests({})), {});
});

test("a repo without releases is left to its branch", async () => {
  assert.equal(await releaseFields([], REPO, manifests({})), null);
  assert.deepEqual(branchFields({ version: "1.2.0", minAppVersion: "2.0.0" }), {
    latest: { version: "1.2.0", from: "branch", minAppVersion: "2.0.0" },
  });
  assert.deepEqual(branchFields(null), {});
  assert.deepEqual(branchFields({ version: "soon" }), {});
});

test("zips are capped at three and must be the repo's own downloads", () => {
  const asset = (name, url = dl("v1.0.0", name)) => ({ name, browser_download_url: url });
  const [r] = eligibleReleases(
    [
      gh("v1.0.0", {
        assets: [
          asset("a.zip"),
          asset("x.txt"),
          asset("b.zip", "https://example.com/b.zip"),
          asset("c.zip"),
          asset("d.zip"),
          asset("e.zip"),
        ],
      }),
    ],
    REPO,
  );
  assert.deepEqual(r.zips, [dl("v1.0.0", "a.zip"), dl("v1.0.0", "c.zip"), dl("v1.0.0", "d.zip")]);
});

test("version order matches the app's", () => {
  assert.equal(compareSemver("1.3.0", "1.3.0-beta.2"), 1);
  assert.equal(compareSemver("1.3.0-beta.10", "1.3.0-beta.2"), 1);
  assert.equal(compareSemver("v1.3", "1.3.0"), 0);
  assert.equal(compareSemver("1.10.0", "1.9.0"), 1);
});

test("a failed lookup keeps the previous build's version fields", () => {
  assert.deepEqual(
    pickVersionFields({ fullName: REPO, stars: 3, latest: { version: "1.0.0", from: "branch" } }),
    { latest: { version: "1.0.0", from: "branch" } },
  );
  assert.deepEqual(pickVersionFields(undefined), {});
});

test("catalogs that differ only in generatedAt are the same", () => {
  const a = { schemaVersion: 1, generatedAt: "2026-10-08T10:00:00Z", extensions: [{ fullName: REPO }] };
  assert.equal(sameCatalog(a, { ...a, generatedAt: "2026-10-08T11:00:00Z" }), true);
  assert.equal(sameCatalog(a, { ...a, extensions: [] }), false);
  assert.equal(sameCatalog(null, a), false);
});

// ── HEAD manifest reads: a missing manifest vs one GitHub could not give us ──

const realFetch = globalThis.fetch;
async function withFetch(stub, run) {
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}
const headManifest = (stub, ms) => withFetch(stub, () => fetchHeadManifest(REPO, ms));
const stalls = (_url, init) =>
  new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
const stallsBody = async (_url, init) =>
  new Response(
    new ReadableStream({
      start(c) {
        init.signal.addEventListener("abort", () => c.error(new Error("aborted")));
      },
    }),
    { status: 200 },
  );

test("a 404 HEAD manifest is missing; other statuses and network errors are unreadable", async () => {
  assert.equal(await headManifest(async () => new Response("", { status: 404 })), null);
  assert.equal(await headManifest(async () => new Response("", { status: 500 })), UNREADABLE);
  assert.equal(await headManifest(async () => new Response("", { status: 429 })), UNREADABLE);
  assert.equal(
    await headManifest(async () => {
      throw new TypeError("fetch failed");
    }),
    UNREADABLE,
  );
});

test("a 200 whose body is not JSON is a missing manifest", async () => {
  assert.equal(await headManifest(async () => new Response("<html>", { status: 200 })), null);
});

test("a HEAD manifest that stalls, in headers or in body, is unreadable", { timeout: 2000 }, async () => {
  assert.equal(await headManifest(stalls, 20), UNREADABLE);
  assert.equal(await headManifest(stallsBody, 20), UNREADABLE);
});

// ── The branch path: what a repo with no releases records ──

const previous = { fullName: REPO, stars: 3, latest: { version: "1.0.0", from: "branch" } };
const branchPath = (stub) => withFetch(stub, async () => branchOrPrevious(await fetchHeadManifest(REPO), previous));

test("an unreadable HEAD manifest keeps the previous build's latest", async () => {
  assert.deepEqual(await branchPath(async () => new Response("", { status: 500 })), {
    latest: { version: "1.0.0", from: "branch" },
  });
});

test("a missing HEAD manifest (404) gives no version fields", async () => {
  assert.deepEqual(await branchPath(async () => new Response("", { status: 404 })), {});
});

test("a readable HEAD manifest gives the branch record", async () => {
  assert.deepEqual(await branchPath(async () => new Response('{"version":"1.2.0"}', { status: 200 })), {
    latest: { version: "1.2.0", from: "branch" },
  });
});

test("an unreadable manifest gives the store thumbnail no icon", () => {
  assert.equal(iconFromManifest(REPO, UNREADABLE), null);
});

// ── Store fields: categories, type, keywords, screenshots, Works with ──

const file = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));

/** Writes JSON bodies (or raw strings) into a fresh temp dir; `put` returns each path. */
function tempFiles() {
  const dir = mkdtempSync(path.join(tmpdir(), "build-registry-"));
  const put = (name, body) => {
    const p = path.join(dir, name);
    writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body));
    return p;
  };
  return { dir, put, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// A small vocabulary of the tests' own, so the committed files can change freely.
const FIXTURE_CATEGORIES = {
  schema: 1,
  categories: [
    { slug: "detail", label: "Detail and repair", description: "Noise, lens faults and other repairs." },
    { slug: "tone", label: "Tone", description: "Shape brightness and contrast." },
    { slug: "export", label: "Export and sharing", description: "Export formats and galleries." },
    { slug: "look", label: "Looks", description: "Film simulation and renderings." },
  ],
  types: [
    { slug: "module", label: "Module" },
    { slug: "pipeline", label: "Processing" },
    { slug: "panel", label: "Panel" },
  ],
};
const FIXTURE_OVERRIDES = { schema: 1, repos: { "acme/watermark": ["export"] } };

const store = await (async () => {
  const tmp = tempFiles();
  try {
    return await loadStoreConfig(tmp.put("categories.json", FIXTURE_CATEGORIES), tmp.put("overrides.json", FIXTURE_OVERRIDES));
  } finally {
    tmp.cleanup();
  }
})();

test("the committed categories.json and category-overrides.json load", async () => {
  const committed = await loadStoreConfig(file("categories.json"), file("category-overrides.json"));
  assert.ok(committed.vocabulary.categories.length > 0);
});

test("a readable manifest gives every store field", () => {
  const manifest = {
    name: "Image Warp",
    categories: ["Develop", "Detail"],
    keywords: ["Liquify", "warp"],
    screenshots: ["docs/one.png"],
    worksWith: ["acme/other"],
  };
  assert.deepEqual(entryStoreFields("acme/warp", ["safelight-pipeline", "safelight-tone"], manifest, undefined, store), {
    fields: {
      name: "Image Warp",
      categories: ["detail"],
      type: "pipeline",
      keywords: ["liquify", "warp"],
      screenshots: ["https://cdn.jsdelivr.net/gh/acme/warp/docs/one.png"],
    },
    declared: ["acme/other"],
    ignored: ["Develop"],
  });
});

test("a missing manifest falls back to topics, then the registry's override", () => {
  assert.deepEqual(entryStoreFields("acme/warp", ["safelight-tone"], null, undefined, store).fields.categories, ["tone"]);
  assert.deepEqual(
    entryStoreFields("Acme/Watermark", ["safelight-panel"], null, undefined, store).fields,
    { categories: ["export"], type: "panel", keywords: [], screenshots: [] },
  );
});

test("an unreadable manifest keeps the previous build's manifest fields; the type is recomputed", () => {
  const previous = {
    fullName: "acme/warp",
    name: "Image Warp",
    categories: ["detail", "retired"],
    type: "panel",
    keywords: ["warp"],
    screenshots: ["https://e.com/a.png"],
    worksWith: ["acme/other"],
  };
  assert.deepEqual(entryStoreFields("acme/warp", ["safelight-module"], UNREADABLE, previous, store), {
    fields: {
      name: "Image Warp",
      categories: ["detail"],
      type: "module",
      keywords: ["warp"],
      screenshots: ["https://e.com/a.png"],
    },
    declared: ["acme/other"],
    ignored: [],
  });
});

test("an unreadable manifest with no previous build reads as no manifest", () => {
  assert.deepEqual(entryStoreFields("acme/warp", ["safelight-tone"], UNREADABLE, undefined, store).fields, {
    categories: ["tone"],
    type: null,
    keywords: [],
    screenshots: [],
  });
});

test("an unreadable manifest with an old-format previous entry reads as no manifest", () => {
  const old = { fullName: "acme/warp", stars: 1 };
  assert.deepEqual(entryStoreFields("acme/warp", ["safelight-tone"], UNREADABLE, old, store), {
    fields: { categories: ["tone"], type: null, keywords: [], screenshots: [] },
    declared: [],
    ignored: [],
  });
  assert.deepEqual(entryStoreFields("acme/watermark", [], UNREADABLE, old, store).fields.categories, ["export"]);
});

test("an unreadable manifest keeps a previous entry whose categories are empty", () => {
  const previous = { fullName: "acme/warp", categories: [], keywords: ["warp"], screenshots: [] };
  assert.deepEqual(entryStoreFields("acme/warp", ["safelight-tone"], UNREADABLE, previous, store).fields, {
    categories: [],
    type: null,
    keywords: ["warp"],
    screenshots: [],
  });
});

test("the payload carries the public vocabulary and two-way links", () => {
  const entry = (fullName) => ({ fullName, thumbnail: null, categories: [], type: null, keywords: [], screenshots: [], worksWith: [], stars: 0 });
  const payload = catalogPayload({
    extensions: [entry("anthonyreimche/Map"), entry("anthonyreimche/GPS-Track")],
    declared: new Map([["anthonyreimche/gps-track", ["anthonyreimche/map"]]]),
    vocabulary: store.vocabulary,
    isVerified: (r) => r === "anthonyreimche/gps-track",
    isBanned: () => false,
    topic: "safelight-extension",
    generatedAt: "2026-10-19T00:00:00Z",
  });
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.count, 2);
  assert.equal(payload.categories.length, 4);
  assert.deepEqual(Object.keys(payload.categories[3]), ["slug", "label", "description"]);
  assert.deepEqual(payload.types.map((t) => t.slug), ["module", "pipeline", "panel"]);
  assert.deepEqual(payload.extensions[0].worksWith, ["anthonyreimche/GPS-Track"]);
  assert.deepEqual(payload.extensions[1].worksWith, ["anthonyreimche/Map"]);
  assert.deepEqual(Object.keys(payload).slice(-3), ["categories", "types", "extensions"]);
});

test("loadStoreConfig refuses a broken vocabulary or overrides, and allows no overrides file", async () => {
  const tmp = tempFiles();
  try {
    const categories = tmp.put("categories.json", FIXTURE_CATEGORIES);
    const overrides = tmp.put("overrides.json", FIXTURE_OVERRIDES);
    const badCategories = tmp.put("bad-categories.json", { schema: 1, categories: [] });
    await assert.rejects(loadStoreConfig(badCategories, overrides), /categories must be a non-empty array/);
    const badOverrides = tmp.put("bad-overrides.json", { schema: 1, repos: { "acme/one": ["nope"] } });
    await assert.rejects(loadStoreConfig(categories, badOverrides), /unknown category "nope"/);
    const none = await loadStoreConfig(categories, path.join(tmp.dir, "absent.json"));
    assert.equal(none.overrides.size, 0);
    await assert.rejects(loadStoreConfig(path.join(tmp.dir, "absent.json"), overrides));
  } finally {
    tmp.cleanup();
  }
});

// ── The verified list, which only feeds reverse Works with links ──

test("loadVerified lowercases both string and { repo } entries", async () => {
  const tmp = tempFiles();
  try {
    const verified = tmp.put("verified.json", {
      verified: ["Acme/Map", { repo: "Acme/GPS-Track", version: "1.0.0", commit: "abc123" }, 7, { version: "1" }],
    });
    const set = await loadVerified(verified);
    assert.ok(set.has("acme/map"));
    assert.ok(set.has("acme/gps-track"));
    assert.equal(set.has("Acme/Map"), false);
  } finally {
    tmp.cleanup();
  }
});

test("loadVerified treats a missing file as nobody verified, without a log line", async () => {
  const tmp = tempFiles();
  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const set = await loadVerified(path.join(tmp.dir, "absent.json"));
    assert.equal(set.size, 0);
    assert.deepEqual(logged, []);
  } finally {
    console.error = realError;
    tmp.cleanup();
  }
});

test("loadVerified logs one line naming a broken file and returns the empty set", async () => {
  const tmp = tempFiles();
  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const bad = tmp.put("verified.json", "{ not json");
    const set = await loadVerified(bad);
    assert.equal(set.size, 0);
    assert.equal(logged.length, 1);
    assert.ok(logged[0].includes(bad));
  } finally {
    console.error = realError;
    tmp.cleanup();
  }
});

test("the store icon refuses non-https schemes", () => {
  assert.equal(iconFromManifest(REPO, { icon: "http://example.com/i.png" }), null);
  assert.equal(iconFromManifest(REPO, { icon: "icon.png" }), `https://cdn.jsdelivr.net/gh/${REPO}/icon.png`);
});
