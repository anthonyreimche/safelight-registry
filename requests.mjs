#!/usr/bin/env node
// Registry requests: the issue forms people fill in (on GitHub or from the
// Safelight website, which opens them prefilled), and what a submitted one
// becomes. requests.yml runs this on every new or edited request issue:
//
//   1. read the form from the issue body and check it, against GitHub where
//      it names a repo or a release;
//   2. on a problem, comment what to fix (an edit runs the check again);
//   3. otherwise write changes/<issue>.json on the branch
//      registry-request/<issue> and open (or update) a pull request that
//      closes the issue. One file per issue, so requests never conflict.
//
// A maintainer reviews and merges; apply-changes.mjs then folds the change
// into the lists. FORMS is the one definition of each form: the issue
// templates in .github/ISSUE_TEMPLATE are rendered from it.
//
// node requests.mjs --issue            handle the issue in GITHUB_EVENT_PATH
// node requests.mjs --write-templates  rewrite .github/ISSUE_TEMPLATE
// node requests.mjs --setup-labels     create the labels the forms apply

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { LIMITS, REPO, parseCategories, resolveCategories } from "./store-fields.mjs";

const REGISTRY = "anthonyreimche/safelight-registry";
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MARKER = "<!-- safelight-registry-request -->";

// ── The forms ────────────────────────────────────────────────────────────────

const repoField = (label = "Repository") => ({
  id: "repo",
  type: "input",
  label,
  description: "owner/repo, or the repository's GitHub URL.",
  placeholder: "owner/repo",
  required: true,
});
const messageField = {
  id: "message",
  type: "input",
  label: "Message",
  description: `Shown on the Discontinued bar, at most ${LIMITS.deprecatedMessage} characters. Leave it empty for "No longer maintained."`,
  placeholder: "Use Framing / Border instead",
  required: false,
};
const confirmField = {
  id: "confirm",
  type: "checkboxes",
  label: "Ownership",
  options: ["I maintain this repository"],
  required: true,
};

export const FORMS = {
  verify: {
    file: "verify.yml",
    label: "verify-request",
    titlePrefix: "Verify: ",
    name: "Get an extension verified",
    description: "Ask for a code review of a release, for the Verified badge in Safelight's Extensions window.",
    intro:
      "A maintainer reads the code of the release you name. Once the pull request this request opens is merged, Safelight shows the extension as Verified and installs it without the unreviewed warning.\n\n" +
      "Verification covers that version only. A newer release shows as unreviewed until it is verified too, so ask again for each release you want covered.\n\n" +
      "Before asking: the repository is public, has the `safelight-extension` topic, and publishes the version as a GitHub Release.",
    fields: [
      repoField(),
      {
        id: "version",
        type: "input",
        label: "Version",
        description: "The release to review. Leave it empty for the latest release.",
        placeholder: "1.2.0",
        required: false,
      },
      {
        id: "notes",
        type: "textarea",
        label: "Notes for the reviewer",
        description: "Anything that helps the review: what changed since the last verified version, the permissions it asks for and why.",
        required: false,
      },
    ],
  },
  discontinue: {
    file: "discontinue.yml",
    label: "discontinue-request",
    titlePrefix: "Discontinue: ",
    name: "Discontinue an extension",
    description: "Mark your extension as discontinued in Safelight's Extensions window.",
    intro:
      "Safelight shows a Discontinued bar on the extension wherever it is installed, with your message and Uninstall, and Browse stops offering it. It stays installed until each person removes it.\n\n" +
      "If another extension takes over from it, use **Replace an extension** instead, so the bar offers the replacement.",
    fields: [repoField(), messageField, confirmField],
  },
  replace: {
    file: "replace.yml",
    label: "replace-request",
    titlePrefix: "Replace: ",
    name: "Replace an extension",
    description: "Point people from an old extension to the one that replaces it, such as a move to a new repository.",
    intro:
      "The old extension gets a Discontinued bar with **Install replacement** and Uninstall wherever it is installed, and Browse stops offering it.\n\n" +
      'To also turn the old extension off for people who install the new one, add `"supersedes": ["<old extension id>"]` to the new extension\'s safelight.json.',
    fields: [
      repoField("Old repository"),
      {
        id: "replacement",
        type: "input",
        label: "New repository",
        description: "owner/repo, or the GitHub URL, of the extension that replaces it.",
        placeholder: "owner/new-repo",
        required: true,
      },
      messageField,
      confirmField,
    ],
  },
  category: {
    file: "category.yml",
    label: "category-request",
    titlePrefix: "Category: ",
    name: "Set an extension's category",
    description: "Choose the store category for an extension whose repository doesn't name one.",
    intro:
      "The Extensions store groups extensions by purpose. An extension normally names its category itself, with a `safelight-<category>` topic or `categories` in its safelight.json, and those always win. Use this for an extension whose author left it untagged.",
    fields: [
      repoField(),
      {
        id: "categories",
        type: "input",
        label: "Categories",
        description: `One to ${LIMITS.perRepo}, by name, separated by commas. The list is in [categories.json](https://github.com/${REGISTRY}/blob/main/categories.json).`,
        placeholder: "Export and sharing, Workflow",
        required: true,
      },
    ],
  },
};

export const KINDS = Object.keys(FORMS);

const q = (s) => JSON.stringify(s);

/** The issue form .github/ISSUE_TEMPLATE/<file> for `kind`, as YAML. */
export function renderTemplate(kind) {
  const f = FORMS[kind];
  const out = [
    "# Rendered from FORMS in requests.mjs: edit it there, then run",
    "# node requests.mjs --write-templates",
    `name: ${q(f.name)}`,
    `description: ${q(f.description)}`,
    `title: ${q(f.titlePrefix)}`,
    `labels: [${q(f.label)}]`,
    "body:",
    "  - type: markdown",
    "    attributes:",
    `      value: ${q(f.intro)}`,
  ];
  for (const field of f.fields) {
    out.push(`  - type: ${field.type}`, `    id: ${field.id}`, "    attributes:", `      label: ${q(field.label)}`);
    if (field.description) out.push(`      description: ${q(field.description)}`);
    if (field.placeholder) out.push(`      placeholder: ${q(field.placeholder)}`);
    if (field.type === "checkboxes") {
      out.push("      options:");
      for (const option of field.options) out.push(`        - label: ${q(option)}`, `          required: ${field.required}`);
    } else {
      out.push("    validations:", `      required: ${field.required}`);
    }
  }
  return out.join("\n") + "\n";
}

const TEMPLATE_CONFIG = [
  "blank_issues_enabled: true",
  "contact_links:",
  "  - name: A problem with Safelight itself",
  "    url: https://github.com/anthonyreimche/SafeLight/issues/new/choose",
  "    about: Bugs and ideas for the app go to the Safelight repository.",
  "",
].join("\n");

// ── Reading a submitted form ─────────────────────────────────────────────────

/** A submitted form's body as label → text. GitHub writes each field as a
 *  "### <label>" heading and its answer; an empty one as "_No response_". */
export function parseIssueBody(body) {
  const fields = new Map();
  const text = String(body ?? "").replace(/\r\n?/g, "\n");
  const parts = text.split(/^### +(.+?) *$/m);
  for (let i = 1; i < parts.length; i += 2) {
    const value = parts[i + 1].trim();
    fields.set(parts[i].trim(), value === "_No response_" || value === "None" ? "" : value);
  }
  return fields;
}

/** `kind`'s fields by id from an issue body; a ticked checkbox reads as true. */
export function fieldsOf(kind, body) {
  const parsed = parseIssueBody(body);
  const out = {};
  for (const field of FORMS[kind].fields) {
    const value = parsed.get(field.label) ?? "";
    out[field.id] = field.type === "checkboxes" ? /^- \[[xX]\]/m.test(value) : value;
  }
  return out;
}

/** Which form an issue came from: its label, else its title prefix. */
export function kindOf(issue) {
  const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l?.name));
  const byLabel = KINDS.find((k) => labels.includes(FORMS[k].label));
  if (byLabel) return byLabel;
  const title = String(issue.title ?? "").toLowerCase();
  return KINDS.find((k) => title.startsWith(FORMS[k].titlePrefix.toLowerCase())) ?? null;
}

const plainRepo = (r) => REPO.test(r) && r.split("/").every((p) => p !== "." && p !== "..");

/** "owner/repo" from owner/repo or a github.com URL, or null. */
export function normalizeRepo(input) {
  let s = String(input ?? "").trim();
  let fromUrl = false;
  const url = /^(?:https?:\/\/)?(?:www\.)?([^/\s]+\.[a-z]{2,})\/(.*)$/i.exec(s);
  if (url) {
    if (url[1].toLowerCase() !== "github.com") return null;
    s = url[2];
    fromUrl = true;
  }
  const parts = s.replace(/[?#].*$/, "").split("/").filter(Boolean);
  if (parts.length < 2 || (!fromUrl && parts.length !== 2)) return null;
  const repo = `${parts[0]}/${parts[1].replace(/\.git$/i, "")}`;
  return plainRepo(repo) ? repo : null;
}

// ── Checking a request ───────────────────────────────────────────────────────

const lc = (s) => String(s ?? "").toLowerCase();
const bareVersion = (v) => String(v ?? "").trim().replace(/^v/i, "");
const entryRepo = (e) => (typeof e === "string" ? e : e?.repo);

/** Check a submitted form. `ctx` = { issue, requester, vocabulary, verified
 *  (verified.json entries), banned ({ repos, owners }), github (a reader with
 *  repo, releases, commitSha and manifest) }. The plan carries the change to
 *  write, or the errors to fix. */
export async function planRequest(kind, fields, ctx) {
  const plan = { form: kind, errors: [], warnings: [], change: null, ownerConfirmed: null };
  const fail = (msg) => plan.errors.push(msg);

  const repo = normalizeRepo(fields.repo);
  if (!repo) {
    fail(`**${FORMS[kind].fields[0].label}** must be owner/repo or a github.com URL.`);
    return plan;
  }
  const info = await ctx.github.repo(repo);
  if (!info) {
    fail(`Couldn't find the public repository ${repo} on GitHub.`);
    return plan;
  }
  const name = info.fullName ?? repo;
  plan.ownerConfirmed = lc(ctx.requester) === lc(info.owner ?? repo.split("/")[0]);
  if (!plan.ownerConfirmed && kind !== "verify")
    plan.warnings.push(`@${ctx.requester} isn't the owner of ${name} on GitHub. Check with the owner before merging.`);

  if (kind === "verify") return planVerify(plan, name, info, fields, ctx);

  if (kind === "category") {
    const names = String(fields.categories ?? "")
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.length === 0 || names.length > LIMITS.perRepo) fail(`Name 1 to ${LIMITS.perRepo} categories.`);
    const { categories, ignored } = resolveCategories({ manifest: { categories: names }, topics: [], vocabulary: ctx.vocabulary });
    if (ignored.length) fail(`Not store categories: ${ignored.join(", ")}.`);
    if (!plan.errors.length) plan.change = { kind: "category", issue: ctx.issue, repo: name, categories };
    return plan;
  }

  // discontinue and replace
  if (!fields.confirm) fail("Tick **I maintain this repository**: only its maintainers can discontinue an extension.");
  const message = String(fields.message ?? "").trim();
  if (message.length > LIMITS.deprecatedMessage) fail(`**Message** is ${message.length} characters; the limit is ${LIMITS.deprecatedMessage}.`);
  let replacedBy = null;
  if (kind === "replace") {
    const replacement = normalizeRepo(fields.replacement);
    if (!replacement) fail("**New repository** must be owner/repo or a github.com URL.");
    else if (lc(replacement) === lc(name)) fail("**New repository** must be another repository than the old one.");
    else {
      const next = await ctx.github.repo(replacement);
      if (!next) fail(`Couldn't find the public repository ${replacement} on GitHub.`);
      else replacedBy = next.fullName ?? replacement;
    }
  }
  if (!plan.errors.length)
    plan.change = { kind: "deprecate", issue: ctx.issue, repo: name, replacedBy, message: message || null };
  return plan;
}

async function planVerify(plan, repo, info, fields, ctx) {
  const fail = (msg) => plan.errors.push(msg);
  const owner = repo.split("/")[0];
  if (ctx.banned.repos.some((r) => lc(r) === lc(repo)) || ctx.banned.owners.some((o) => lc(o) === lc(owner))) {
    fail(`${repo} is banned by the registry and can't be verified.`);
    return plan;
  }
  const asked = bareVersion(fields.version);
  const releases = (await ctx.github.releases(repo)).filter((r) => !r.draft);
  let ref;
  let tagVersion = null;
  if (asked) {
    const release = releases.find((r) => r.tag === asked || r.tag === `v${asked}`);
    if (!release) {
      fail(`No release of ${repo} is tagged ${asked} or v${asked}.`);
      return plan;
    }
    ref = release.tag;
    tagVersion = asked;
  } else if (releases.length) {
    const release = releases.find((r) => !r.prerelease) ?? releases[0];
    ref = release.tag;
    tagVersion = bareVersion(release.tag);
  } else {
    ref = info.defaultBranch ?? "main";
  }
  const commit = await ctx.github.commitSha(repo, ref);
  if (!commit) {
    fail(`Couldn't read the commit for ${ref} in ${repo}.`);
    return plan;
  }
  const manifest = await ctx.github.manifest(repo, commit);
  if (!manifest || typeof manifest !== "object") {
    fail(`${repo} has no readable safelight.json at ${ref}.`);
    return plan;
  }
  for (const key of ["id", "name", "version", "main"])
    if (typeof manifest[key] !== "string" || !manifest[key].trim()) fail(`safelight.json at ${ref} has no \`${key}\`.`);
  if (plan.errors.length) return plan;
  const version = bareVersion(manifest.version);
  if (!SEMVER.test(version)) fail(`safelight.json at ${ref} has version ${manifest.version}, which isn't major.minor.patch.`);
  else if (tagVersion && version !== tagVersion)
    fail(`The release ${ref} holds a safelight.json with version ${version}. Tag and manifest must agree.`);
  if (plan.errors.length) return plan;
  const previous = ctx.verified.find((e) => lc(entryRepo(e)) === lc(repo));
  plan.previous =
    previous && typeof previous === "object"
      ? { version: previous.version ?? null, commit: previous.commit ?? null }
      : previous
        ? { version: null, commit: null }
        : null;
  plan.ref = ref;
  plan.manifest = { id: manifest.id, name: manifest.name, permissions: manifest.permissions ?? null };
  plan.notes = String(fields.notes ?? "").trim();
  plan.change = { kind: "verify", issue: ctx.issue, repo, version, commit };
  return plan;
}

// ── What a request becomes ───────────────────────────────────────────────────

export const changePathFor = (issue) => `changes/${issue}.json`;
export const branchFor = (issue) => `registry-request/${issue}`;

function titleOf(plan) {
  const c = plan.change;
  switch (c.kind) {
    case "verify":
      return `Verify ${c.repo} ${c.version}`;
    case "category":
      return `Categories for ${c.repo}: ${c.categories.join(", ")}`;
    default:
      return c.replacedBy ? `Replace ${c.repo} with ${c.replacedBy}` : `Discontinue ${c.repo}`;
  }
}

/** The pull request a checked request opens: title, body and labels. */
export function pullRequestFor(plan, { number, requester }) {
  const c = plan.change;
  const lines = [`Requested by @${requester} in #${number}.`, ""];
  if (c.kind === "verify") {
    lines.push(
      `- Release: ${plan.ref ?? c.version} (${c.version}), commit [${c.commit.slice(0, 7)}](https://github.com/${c.repo}/tree/${c.commit})`,
    );
    if (plan.manifest) lines.push(`- Extension: ${plan.manifest.name} (\`${plan.manifest.id}\`)`);
    if (plan.manifest?.permissions) lines.push(`- Permissions: \`${JSON.stringify(plan.manifest.permissions)}\``);
    lines.push(
      plan.previous?.commit
        ? `- Changes since the last verified version (${plan.previous.version}): https://github.com/${c.repo}/compare/${plan.previous.commit}...${c.commit}`
        : plan.previous
          ? "- Verified before without a pinned version: review the whole repository."
          : "- Not verified before: review the whole repository.",
    );
    if (plan.notes) lines.push("", "Notes from the requester:", "", ...plan.notes.split("\n").map((l) => `> ${l}`));
    lines.push("", "Before merging:", "- [ ] Read the code at this commit, including the built bundle", "- [ ] The permissions it declares match what it does");
  } else if (c.kind === "category") {
    lines.push(`- Categories: ${c.categories.join(", ")}`);
  } else {
    lines.push(`- Discontinued: ${c.repo}`, `- Replaced by: ${c.replacedBy ?? "nothing"}`, `- Message: ${c.message ?? "(none: \"No longer maintained.\")"}`);
  }
  if (plan.warnings.length) lines.push("", ...plan.warnings.map((w) => `> [!WARNING]\n> ${w}`));
  lines.push("", `Closes #${number}`, "", `Merging adds \`${changePathFor(number)}\`; the Apply registry requests workflow folds it into the lists.`);
  const labels = [FORMS[plan.form].label];
  if (plan.ownerConfirmed === false && plan.form !== "verify") labels.push("owner-unconfirmed");
  return { title: titleOf(plan), body: lines.join("\n"), labels };
}

function errorComment(plan) {
  return [
    MARKER,
    "This request can't go ahead yet:",
    "",
    ...plan.errors.map((e) => `- ${e}`),
    "",
    "Edit the issue to fix it; the check runs again on every edit.",
  ].join("\n");
}

function acceptedComment(plan, prUrl) {
  return [
    MARKER,
    `Thanks. This request is now ${prUrl}. A maintainer reviews it, and merging it closes this issue.`,
    ...(plan.warnings.length ? ["", ...plan.warnings.map((w) => `- ${w}`)] : []),
    "",
    "Editing the issue updates the pull request.",
  ].join("\n");
}

// ── GitHub ───────────────────────────────────────────────────────────────────

function gitHub(token) {
  if (!token) throw new Error("No GitHub token.");
  async function call(method, path, body) {
    const res = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "safelight-registry-requests",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw Object.assign(new Error(`${method} ${path}: ${res.status} ${await res.text()}`), { status: res.status });
    return res.status === 204 ? {} : res.json();
  }
  const reader = {
    async repo(r) {
      const j = await call("GET", `/repos/${r}`);
      return j && !j.private
        ? { fullName: j.full_name, owner: j.owner?.login, defaultBranch: j.default_branch, archived: !!j.archived }
        : null;
    },
    async releases(r) {
      const list = (await call("GET", `/repos/${r}/releases?per_page=100`)) ?? [];
      return list.map((x) => ({ tag: x.tag_name, draft: !!x.draft, prerelease: !!x.prerelease }));
    },
    async commitSha(r, ref) {
      return (await call("GET", `/repos/${r}/commits/${encodeURIComponent(ref)}`))?.sha ?? null;
    },
    async manifest(r, sha) {
      const j = await call("GET", `/repos/${r}/contents/safelight.json?ref=${sha}`);
      if (!j?.content) return null;
      try {
        return JSON.parse(Buffer.from(j.content, "base64").toString("utf8"));
      } catch {
        return null;
      }
    },
  };
  return { call, reader };
}

async function upsertComment(gh, repo, number, body) {
  const comments = (await gh.call("GET", `/repos/${repo}/issues/${number}/comments?per_page=100`)) ?? [];
  const mine = comments.find((c) => c.body?.includes(MARKER) && c.user?.type === "Bot");
  if (mine) await gh.call("PATCH", `/repos/${repo}/issues/comments/${mine.id}`, { body });
  else await gh.call("POST", `/repos/${repo}/issues/${number}/comments`, { body });
}

async function setLabel(gh, repo, number, label, on) {
  try {
    if (on) await gh.call("POST", `/repos/${repo}/issues/${number}/labels`, { labels: [label] });
    else await gh.call("DELETE", `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`);
  } catch (e) {
    console.error(`label ${label}: ${e.message}`);
  }
}

/** Write the change file on the request's branch and open or update its pull
 *  request. A branch left from a merged or closed one starts again from base. */
async function openPullRequest(gh, repo, base, plan, issue) {
  const branch = branchFor(issue.number);
  const path = changePathFor(issue.number);
  const pr = pullRequestFor(plan, { number: issue.number, requester: issue.user.login });
  const baseSha = (await gh.call("GET", `/repos/${repo}/git/ref/heads/${base}`)).object.sha;
  const [owner] = repo.split("/");
  const open = ((await gh.call("GET", `/repos/${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(branch)}`)) ?? [])[0];
  const existing = await gh.call("GET", `/repos/${repo}/git/ref/heads/${branch}`);
  if (!existing) await gh.call("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseSha });
  else if (!open) await gh.call("PATCH", `/repos/${repo}/git/refs/heads/${branch}`, { sha: baseSha, force: true });
  const content = JSON.stringify(plan.change, null, 2) + "\n";
  const file = await gh.call("GET", `/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`);
  if (!file || Buffer.from(file.content, "base64").toString("utf8") !== content)
    await gh.call("PUT", `/repos/${repo}/contents/${path}`, {
      message: `${pr.title} (#${issue.number})`,
      content: Buffer.from(content).toString("base64"),
      branch,
      ...(file ? { sha: file.sha } : {}),
    });
  const result = open
    ? await gh.call("PATCH", `/repos/${repo}/pulls/${open.number}`, { title: pr.title, body: pr.body })
    : await gh.call("POST", `/repos/${repo}/pulls`, { title: pr.title, head: branch, base, body: pr.body });
  await gh.call("POST", `/repos/${repo}/issues/${result.number}/labels`, { labels: pr.labels });
  return result;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function handleIssue() {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const issue = event.issue;
  if (!issue || issue.pull_request || issue.state !== "open") return;
  const kind = kindOf(issue);
  if (!kind) return;
  const repo = process.env.GITHUB_REPOSITORY;
  const base = event.repository?.default_branch ?? "main";
  const bot = gitHub(process.env.GITHUB_TOKEN);
  const pusher = process.env.REGISTRY_PUSH_TOKEN ? gitHub(process.env.REGISTRY_PUSH_TOKEN) : bot;
  const verified = await readJson("verified.json", { verified: [] });
  const banned = await readJson("banned.json", { repos: [], owners: [] });
  const { vocabulary } = parseCategories(await readJson("categories.json", null));
  const plan = await planRequest(kind, fieldsOf(kind, issue.body), {
    issue: issue.number,
    requester: issue.user.login,
    vocabulary,
    verified: verified.verified ?? [],
    banned: { repos: banned.repos ?? [], owners: banned.owners ?? [] },
    github: bot.reader,
  });
  if (plan.errors.length) {
    await upsertComment(bot, repo, issue.number, errorComment(plan));
    await setLabel(bot, repo, issue.number, "needs-changes", true);
    console.error(`#${issue.number}: ${plan.errors.join(" ")}`);
    return;
  }
  if ((issue.labels ?? []).some((l) => (l?.name ?? l) === "needs-changes"))
    await setLabel(bot, repo, issue.number, "needs-changes", false);
  const pr = await openPullRequest(pusher, repo, base, plan, issue);
  await upsertComment(bot, repo, issue.number, acceptedComment(plan, pr.html_url));
  console.error(`#${issue.number}: ${pr.html_url}`);
}

const LABELS = [
  ...KINDS.map((k) => ({ name: FORMS[k].label, color: "1f6feb", description: FORMS[k].name })),
  { name: "needs-changes", color: "d93f0b", description: "A registry request with something to fix" },
  { name: "owner-unconfirmed", color: "fbca04", description: "Asked for by someone other than the repository's owner" },
];

async function setupLabels() {
  const gh = gitHub(process.env.GITHUB_TOKEN);
  for (const label of LABELS) {
    try {
      await gh.call("POST", `/repos/${process.env.GITHUB_REPOSITORY}/labels`, label);
      console.error(`created ${label.name}`);
    } catch (e) {
      if (e.status !== 422) throw e;
      console.error(`${label.name} exists`);
    }
  }
}

async function writeTemplates() {
  const dir = new URL("./.github/ISSUE_TEMPLATE/", import.meta.url);
  await mkdir(dir, { recursive: true });
  for (const kind of KINDS) await writeFile(new URL(FORMS[kind].file, dir), renderTemplate(kind));
  await writeFile(new URL("config.yml", dir), TEMPLATE_CONFIG);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  const run = mode === "--write-templates" ? writeTemplates : mode === "--setup-labels" ? setupLabels : handleIssue;
  run().catch((e) => {
    console.error("requests failed:", e?.message || e);
    process.exit(1);
  });
}
