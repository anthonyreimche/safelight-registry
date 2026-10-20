// Store grouping for registry.json: the category vocabulary (categories.json),
// the categories the registry gives repos their authors left untagged
// (category-overrides.json), and the per-repo fields the Extensions store
// groups and links by. Pure functions shared by build-registry.mjs and
// validate-categories.mjs. The app reads the results in registry.json, never
// these files.

export const SLUG = /^[a-z][a-z0-9-]{0,23}$/;
// The store's Browse keys: its home page and the uncategorised list.
export const RESERVED = ["home", "other"];
export const REPO = /^[\w.-]+\/[\w.-]+$/;
export const LIMITS = {
  categories: 16,
  perRepo: 3,
  label: 24,
  description: 140,
  keywords: 20,
  keywordLength: 40,
  screenshots: 6,
  worksWith: 6,
  assetUrl: 2048,
};

const lc = (s) => String(s ?? "").trim().toLowerCase();
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === "string") : []);

function checkText(errors, at, value, max) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${at} must not be empty`);
    return;
  }
  const length = value.trim().length;
  if (length > max) errors.push(`${at} is ${length} characters; the limit is ${max}`);
}

/** categories.json → { vocabulary, errors }; vocabulary is null on any error. */
export function parseCategories(doc) {
  if (!isObject(doc)) return { vocabulary: null, errors: ["categories.json must be an object"] };
  const errors = [];
  if (doc.schema !== 1) errors.push("schema must be 1");
  if (!Array.isArray(doc.categories) || doc.categories.length === 0)
    return { vocabulary: null, errors: [...errors, "categories must be a non-empty array"] };
  if (doc.categories.length > LIMITS.categories)
    errors.push(`at most ${LIMITS.categories} categories (found ${doc.categories.length})`);

  const categories = [];
  doc.categories.forEach((c, i) => {
    const at = `categories[${i}]`;
    if (!isObject(c)) {
      errors.push(`${at} must be an object`);
      return;
    }
    if (typeof c.slug !== "string" || !SLUG.test(c.slug)) errors.push(`${at}.slug must match ${SLUG}`);
    else if (RESERVED.includes(c.slug)) errors.push(`${at}.slug "${c.slug}" is reserved by the store`);
    else if (categories.some((k) => k.slug === c.slug)) errors.push(`${at}.slug "${c.slug}" is a duplicate`);
    checkText(errors, `${at}.label`, c.label, LIMITS.label);
    checkText(errors, `${at}.description`, c.description, LIMITS.description);
    if (
      c.aliases !== undefined &&
      (!Array.isArray(c.aliases) || c.aliases.some((a) => typeof a !== "string" || !a.trim()))
    )
      errors.push(`${at}.aliases must be an array of non-empty strings`);
    categories.push({
      slug: String(c.slug ?? ""),
      label: String(c.label ?? "").trim(),
      description: String(c.description ?? "").trim(),
      aliases: strings(c.aliases).map((a) => a.trim()).filter(Boolean),
    });
  });

  // A manifest names a category by slug, label or alias, so no name may
  // stand for two categories, and an alias must add a name, not repeat one.
  const names = new Map();
  categories.forEach((c, i) => {
    if (c.slug) names.set(c.slug, i);
  });
  categories.forEach((c, i) => {
    const key = lc(c.label);
    if (!key) return;
    if (names.has(key) && names.get(key) !== i)
      errors.push(`categories[${i}].label "${c.label}" clashes with categories[${names.get(key)}]`);
    else names.set(key, i);
  });
  const aliases = new Set();
  categories.forEach((c, i) =>
    c.aliases.forEach((a, k) => {
      const key = lc(a);
      if (names.has(key)) errors.push(`categories[${i}].aliases[${k}] "${a}" matches a slug or label`);
      else if (aliases.has(key)) errors.push(`categories[${i}].aliases[${k}] "${a}" repeats another alias`);
      else aliases.add(key);
    }),
  );

  const types = [];
  if (!Array.isArray(doc.types)) errors.push("types must be an array");
  else
    doc.types.forEach((t, i) => {
      const at = `types[${i}]`;
      if (!isObject(t)) {
        errors.push(`${at} must be an object`);
        return;
      }
      if (typeof t.slug !== "string" || !SLUG.test(t.slug)) errors.push(`${at}.slug must match ${SLUG}`);
      else if (types.some((k) => k.slug === t.slug)) errors.push(`${at}.slug "${t.slug}" is a duplicate`);
      else if (categories.some((c) => c.slug === t.slug))
        errors.push(`${at}.slug "${t.slug}" is also a category slug`);
      checkText(errors, `${at}.label`, t.label, LIMITS.label);
      types.push({ slug: String(t.slug ?? ""), label: String(t.label ?? "").trim() });
    });

  return errors.length ? { vocabulary: null, errors } : { vocabulary: { categories, types }, errors };
}

/** category-overrides.json → { overrides, errors }: lowercased repo → slugs. */
export function parseOverrides(doc, vocabulary) {
  const overrides = new Map();
  if (!isObject(doc)) return { overrides, errors: ["category-overrides.json must be an object"] };
  const errors = [];
  if (doc.schema !== 1) errors.push("schema must be 1");
  if (!isObject(doc.repos)) return { overrides, errors: [...errors, "repos must be an object"] };
  const known = new Set((vocabulary?.categories ?? []).map((c) => c.slug));
  for (const [repo, slugs] of Object.entries(doc.repos)) {
    const at = `repos["${repo}"]`;
    const key = lc(repo);
    if (!REPO.test(key)) {
      errors.push(`${at} must be "owner/repo"`);
      continue;
    }
    if (overrides.has(key)) {
      errors.push(`${at} repeats another repo`);
      continue;
    }
    if (!Array.isArray(slugs) || slugs.length === 0) {
      errors.push(`${at} must be a non-empty array`);
      continue;
    }
    if (slugs.length > LIMITS.perRepo)
      errors.push(`${at} has ${slugs.length} categories; the limit is ${LIMITS.perRepo}`);
    const unique = [];
    for (const s of slugs) {
      if (!known.has(s)) errors.push(`${at} names unknown category "${s}"`);
      else if (unique.includes(s)) errors.push(`${at} repeats category "${s}"`);
      else unique.push(s);
    }
    overrides.set(key, unique.slice(0, LIMITS.perRepo));
  }
  return { overrides, errors };
}

/** The vocabulary as registry.json publishes it: aliases only matter here. */
export const publicVocabulary = ({ categories, types }) => ({
  categories: categories.map(({ slug, label, description }) => ({ slug, label, description })),
  types: types.map(({ slug, label }) => ({ slug, label })),
});

// ── Per-repo fields ──

function nameTable(vocabulary) {
  const table = new Map();
  for (const c of vocabulary.categories)
    for (const name of [c.slug, c.label, ...c.aliases]) table.set(lc(name), c.slug);
  return table;
}

const topicSet = (topics) => new Set((Array.isArray(topics) ? topics : []).map((t) => lc(t)));

/** An author's manifest categories win when any match the vocabulary; then
 *  the repo's purpose topics; then the registry's override. */
export function resolveCategories({ manifest, topics, override, vocabulary }) {
  const table = nameTable(vocabulary);
  const fromManifest = [];
  const ignored = [];
  for (const value of strings(isObject(manifest) ? manifest.categories : undefined)) {
    const name = value.trim();
    const slug = table.get(lc(name));
    if (slug) {
      if (!fromManifest.includes(slug)) fromManifest.push(slug);
    } else if (name) ignored.push(name);
  }
  if (fromManifest.length) return { categories: fromManifest.slice(0, LIMITS.perRepo), ignored };
  const tagged = topicSet(topics);
  const fromTopics = vocabulary.categories.map((c) => c.slug).filter((s) => tagged.has(`safelight-${s}`));
  if (fromTopics.length) return { categories: fromTopics.slice(0, LIMITS.perRepo), ignored };
  return { categories: (override ?? []).slice(0, LIMITS.perRepo), ignored };
}

/** The first type, in the vocabulary's order, whose topic the repo carries. */
export function resolveType(topics, vocabulary) {
  const tagged = topicSet(topics);
  return vocabulary.types.find((t) => tagged.has(`safelight-${t.slug}`))?.slug ?? null;
}

export function cleanKeywords(manifest) {
  const out = [];
  for (const k of strings(isObject(manifest) ? manifest.keywords : undefined)) {
    const word = k.trim().toLowerCase();
    if (word && word.length <= LIMITS.keywordLength && !out.includes(word)) out.push(word);
  }
  return out.slice(0, LIMITS.keywords);
}

/** An image URL for the registry: https only. An https URL is kept as it is,
 *  on any host; a repo-relative path goes to jsDelivr. Absolute paths, `..`,
 *  other schemes and anything over LIMITS.assetUrl characters are refused, so
 *  a manifest can't make every app download a huge URL from registry.json. */
export function resolveAssetUrl(repo, value) {
  const v = typeof value === "string" ? value.trim() : "";
  if (v.length > LIMITS.assetUrl) return null;
  if (/^https:\/\//i.test(v)) return v;
  if (!v || v.startsWith("/") || v.includes("..") || /^[a-z][a-z0-9+.-]*:/i.test(v)) return null;
  return `https://cdn.jsdelivr.net/gh/${repo}/${v.replace(/^\.?\//, "")}`;
}

export function cleanScreenshots(repo, manifest) {
  const out = [];
  for (const s of strings(isObject(manifest) ? manifest.screenshots : undefined)) {
    const url = resolveAssetUrl(repo, s);
    if (url && !out.includes(url)) out.push(url);
  }
  return out.slice(0, LIMITS.screenshots);
}

export function declaredWorksWith(fullName, manifest) {
  const self = lc(fullName);
  const out = [];
  for (const r of strings(isObject(manifest) ? manifest.worksWith : undefined)) {
    const repo = r.trim();
    const key = lc(repo);
    if (REPO.test(repo) && key !== self && !out.some((o) => lc(o) === key)) out.push(repo);
  }
  return out.slice(0, LIMITS.worksWith);
}

/** Two-way Works with links over the finished catalog. A link shows on the
 *  declarer's page when the target is listed, and on the target's page only
 *  when the declarer is verified, so nobody can attach themselves to a
 *  popular extension by declaring it. */
export function linkWorksWith(extensions, declared, { isVerified, isBanned }) {
  const order = extensions.map((e) => lc(e.fullName));
  const cased = new Map(extensions.map((e) => [lc(e.fullName), e.fullName]));
  const forward = new Map();
  const reverse = new Map();
  const add = (map, from, to) => map.set(from, (map.get(from) ?? new Set()).add(to));
  for (const [from, targets] of declared) {
    if (!cased.has(from) || isBanned(from)) continue;
    for (const target of targets) {
      const to = lc(target);
      if (to === from || !cased.has(to) || isBanned(to)) continue;
      add(forward, from, to);
      if (isVerified(from)) add(reverse, to, from);
    }
  }
  const links = new Map();
  for (const key of order) {
    const own = forward.get(key) ?? new Set();
    const back = reverse.get(key) ?? new Set();
    const list = [...order.filter((k) => own.has(k)), ...order.filter((k) => back.has(k) && !own.has(k))];
    links.set(key, list.slice(0, LIMITS.worksWith).map((k) => cased.get(k)));
  }
  return links;
}
