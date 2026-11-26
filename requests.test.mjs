// Tests for requests.mjs: reading a submitted issue form, checking it, and the
// change file and pull request it becomes. Run: node --test requests.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCategories } from "./store-fields.mjs";
import {
  FORMS,
  KINDS,
  branchFor,
  changePathFor,
  fieldsOf,
  kindOf,
  normalizeRepo,
  parseIssueBody,
  planRequest,
  pullRequestFor,
  renderTemplate,
  stuckComment,
} from "./requests.mjs";

const vocabulary = parseCategories(JSON.parse(readFileSync(new URL("./categories.json", import.meta.url), "utf8")))
  .vocabulary;

/** An issue body as GitHub writes it for a submitted form. */
const body = (sections) =>
  Object.entries(sections)
    .map(([label, value]) => `### ${label}\n\n${value}`)
    .join("\n\n");

/** A fake GitHub reader over one repo's releases, commits and manifests. */
function fakeGitHub({
  repos = { "acme/warp": { owner: "acme", defaultBranch: "main", archived: false } },
  releases = { "acme/warp": [{ tag: "v1.2.0", draft: false, prerelease: false }] },
  commits = { "acme/warp@v1.2.0": "a".repeat(40), "acme/warp@main": "b".repeat(40) },
  manifests = { [`acme/warp@${"a".repeat(40)}`]: { id: "acme.warp", name: "Warp", version: "1.2.0", main: "dist/index.js" } },
} = {}) {
  const key = (r) => r.toLowerCase();
  const find = (map, r) => Object.entries(map).find(([k]) => key(k) === key(r))?.[1];
  return {
    repo: async (r) => find(repos, r) ?? null,
    releases: async (r) => find(releases, r) ?? [],
    commitSha: async (r, ref) => find(commits, `${r}@${ref}`) ?? null,
    manifest: async (r, sha) => find(manifests, `${r}@${sha}`) ?? null,
  };
}

const context = (over = {}) => ({
  issue: 42,
  requester: "acme",
  vocabulary,
  verified: [],
  banned: { repos: [], owners: [] },
  github: fakeGitHub(),
  ...over,
});

// ── Reading the form ──

test("an issue body reads into label → value, with no response as empty and checkboxes as ticked labels", () => {
  const parsed = parseIssueBody(
    body({
      Repository: "acme/warp\n",
      Version: "_No response_",
      Confirmation: "- [X] I maintain this repository\n- [ ] Something else",
    }),
  );
  assert.equal(parsed.get("Repository"), "acme/warp");
  assert.equal(parsed.get("Version"), "");
  assert.deepEqual(parsed.get("Confirmation"), "- [X] I maintain this repository\n- [ ] Something else");
});

test("a CRLF body reads the same", () => {
  const parsed = parseIssueBody("### Repository\r\n\r\nacme/warp\r\n\r\n### Version\r\n\r\n1.0.0\r\n");
  assert.equal(parsed.get("Repository"), "acme/warp");
  assert.equal(parsed.get("Version"), "1.0.0");
});

test("fields map each form's labels to its ids; ticked boxes read as true", () => {
  const fields = fieldsOf(
    "discontinue",
    body({
      [FORMS.discontinue.fields.find((f) => f.id === "repo").label]: "acme/warp",
      [FORMS.discontinue.fields.find((f) => f.id === "message").label]: "Use Next",
      [FORMS.discontinue.fields.find((f) => f.id === "confirm").label]: `- [X] ${FORMS.discontinue.fields.find((f) => f.id === "confirm").options[0]}`,
    }),
  );
  assert.deepEqual(fields, { repo: "acme/warp", message: "Use Next", confirm: true });
});

test("the kind comes from the form's label, then from its title prefix", () => {
  for (const kind of KINDS) {
    assert.equal(kindOf({ labels: [{ name: FORMS[kind].label }], title: "x" }), kind);
    assert.equal(kindOf({ labels: [], title: `${FORMS[kind].titlePrefix}acme/warp` }), kind);
  }
  assert.equal(kindOf({ labels: [{ name: "bug" }], title: "It crashes" }), null);
});

test("repos read from owner/repo or a GitHub URL; anything else is refused", () => {
  assert.equal(normalizeRepo(" acme/warp "), "acme/warp");
  assert.equal(normalizeRepo("https://github.com/Acme/Warp.git"), "Acme/Warp");
  assert.equal(normalizeRepo("github.com/acme/warp/tree/main"), "acme/warp");
  for (const bad of ["", "acme", "../warp", "acme/..", "acme/warp/extra thing", "https://gitlab.com/a/b"])
    assert.equal(normalizeRepo(bad), null, bad);
});

// ── Checking requests ──

test("a verify request pins the latest release's version and commit", async () => {
  const plan = await planRequest("verify", { repo: "acme/warp", version: "", notes: "" }, context());
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.change, {
    kind: "verify",
    issue: 42,
    repo: "acme/warp",
    version: "1.2.0",
    commit: "a".repeat(40),
  });
});

test("a verify request for a named version finds its release, with or without the v", async () => {
  const plan = await planRequest("verify", { repo: "acme/warp", version: "v1.2.0" }, context());
  assert.equal(plan.change.version, "1.2.0");
  assert.equal(plan.change.commit, "a".repeat(40));
});

test("a repo without releases is verified at its default branch's head", async () => {
  const github = fakeGitHub({
    releases: { "acme/warp": [] },
    manifests: { [`acme/warp@${"b".repeat(40)}`]: { id: "acme.warp", name: "Warp", version: "0.3.0", main: "i.js" } },
  });
  const plan = await planRequest("verify", { repo: "acme/warp", version: "" }, context({ github }));
  assert.deepEqual(plan.errors, []);
  assert.equal(plan.change.version, "0.3.0");
  assert.equal(plan.change.commit, "b".repeat(40));
});

test("a verify request is refused for a missing repo, a missing release, a bad manifest or a ban", async () => {
  const missing = await planRequest("verify", { repo: "acme/nothing" }, context());
  assert.match(missing.errors.join(), /acme\/nothing/);
  const noRelease = await planRequest("verify", { repo: "acme/warp", version: "9.9.9" }, context());
  assert.match(noRelease.errors.join(), /9\.9\.9/);
  const wrongVersion = await planRequest(
    "verify",
    { repo: "acme/warp" },
    context({
      github: fakeGitHub({
        manifests: { [`acme/warp@${"a".repeat(40)}`]: { id: "acme.warp", name: "Warp", version: "1.1.0", main: "i.js" } },
      }),
    }),
  );
  assert.match(wrongVersion.errors.join(), /1\.1\.0/);
  const noManifest = await planRequest("verify", { repo: "acme/warp" }, context({ github: fakeGitHub({ manifests: {} }) }));
  assert.match(noManifest.errors.join(), /safelight\.json/);
  const banned = await planRequest("verify", { repo: "acme/warp" }, context({ banned: { repos: ["ACME/warp"], owners: [] } }));
  assert.match(banned.errors.join(), /banned/);
});

test("a verify request names the commit it last reviewed, for the compare link", async () => {
  const plan = await planRequest(
    "verify",
    { repo: "acme/warp" },
    context({ verified: [{ repo: "Acme/Warp", version: "1.0.0", commit: "c".repeat(40) }] }),
  );
  assert.equal(plan.previous.commit, "c".repeat(40));
});

test("a discontinue request marks the repo, with its message", async () => {
  const plan = await planRequest("discontinue", { repo: "acme/warp", message: " No longer kept up ", confirm: true }, context());
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.change, { kind: "deprecate", issue: 42, repo: "acme/warp", replacedBy: null, message: "No longer kept up" });
  assert.deepEqual(plan.warnings, []);
});

test("a discontinue request needs the box ticked and a message that fits", async () => {
  const plan = await planRequest("discontinue", { repo: "acme/warp", message: "x".repeat(141), confirm: false }, context());
  assert.equal(plan.errors.length, 2);
});

test("someone other than the repo's owner gets a warning for the maintainer, not a refusal", async () => {
  const plan = await planRequest("discontinue", { repo: "acme/warp", confirm: true }, context({ requester: "someone" }));
  assert.deepEqual(plan.errors, []);
  assert.match(plan.warnings.join(), /someone/);
  assert.equal(plan.ownerConfirmed, false);
});

test("a replace request needs a replacement that exists and isn't the repo itself", async () => {
  const github = fakeGitHub({
    repos: {
      "acme/warp": { owner: "acme", defaultBranch: "main" },
      "acme/warp-2": { owner: "acme", defaultBranch: "main" },
    },
  });
  const ok = await planRequest("replace", { repo: "acme/warp", replacement: "https://github.com/acme/warp-2", confirm: true }, context({ github }));
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.change, { kind: "deprecate", issue: 42, repo: "acme/warp", replacedBy: "acme/warp-2", message: null });
  const self = await planRequest("replace", { repo: "acme/warp", replacement: "Acme/Warp", confirm: true }, context({ github }));
  assert.equal(self.errors.length, 1);
  const missing = await planRequest("replace", { repo: "acme/warp", replacement: "acme/gone", confirm: true }, context({ github }));
  assert.match(missing.errors.join(), /acme\/gone/);
});

test("harmful-extension reports are private: no public form, and a report issue isn't a request", () => {
  assert.ok(!KINDS.includes("report"));
  assert.equal(kindOf({ labels: [{ name: "ban-report" }], title: "Report: acme/warp" }), null);
  const dir = new URL("./.github/ISSUE_TEMPLATE/", import.meta.url);
  assert.throws(() => readFileSync(new URL("report.yml", dir)));
  assert.match(readFileSync(new URL("config.yml", dir), "utf8"), /security\/advisories\/new/);
});

test("a category request names one to three categories by label, slug or alias", async () => {
  const plan = await planRequest("category", { repo: "acme/warp", categories: "Export and sharing, tone", confirm: true }, context());
  assert.deepEqual(plan.errors, []);
  assert.deepEqual(plan.change, { kind: "category", issue: 42, repo: "acme/warp", categories: ["export", "tone"] });
  const unknown = await planRequest("category", { repo: "acme/warp", categories: "Spaceships", confirm: true }, context());
  assert.match(unknown.errors.join(), /Spaceships/);
  const many = await planRequest("category", { repo: "acme/warp", categories: "tone, look, export, color", confirm: true }, context());
  assert.equal(many.errors.length, 1);
});

// ── What a request becomes ──

test("each issue has its own change file and branch, so requests never share a file", () => {
  assert.equal(changePathFor(42), "changes/42.json");
  assert.equal(branchFor(42), "registry-request/42");
});

test("the pull request closes the issue and says what to check", async () => {
  const plan = await planRequest(
    "verify",
    { repo: "acme/warp" },
    context({ verified: [{ repo: "acme/warp", version: "1.0.0", commit: "c".repeat(40) }] }),
  );
  const pr = pullRequestFor(plan, { number: 42, requester: "acme" });
  assert.equal(pr.title, "Verify acme/warp 1.2.0");
  assert.match(pr.body, /Closes #42/);
  assert.match(pr.body, new RegExp(`compare/${"c".repeat(40)}\\.\\.\\.${"a".repeat(40)}`));
});

test("a request whose pull request can't be opened tells the requester and calls the maintainer", () => {
  const error = new Error(`POST /repos/acme/reg/pulls: 403 {"message":"Resource not accessible by personal access token"}${" x".repeat(400)}`);
  const comment = stuckComment(error, "acme");
  assert.match(comment, /<!-- safelight-registry-request -->/);
  assert.match(comment, /@acme/);
  assert.match(comment, /Resource not accessible by personal access token/);
  assert.ok(comment.length < 900, "the error is cut short");
});

// ── The forms themselves ──

test("the committed issue forms are the ones FORMS renders", () => {
  for (const kind of KINDS) {
    const file = new URL(`./.github/ISSUE_TEMPLATE/${FORMS[kind].file}`, import.meta.url);
    assert.equal(readFileSync(file, "utf8"), renderTemplate(kind), `${FORMS[kind].file} is stale: run node requests.mjs --write-templates`);
  }
});

test("every field has a unique id a URL can fill in", () => {
  for (const kind of KINDS) {
    const ids = FORMS[kind].fields.map((f) => f.id);
    assert.equal(new Set(ids).size, ids.length, kind);
    for (const id of ids) assert.match(id, /^[a-z][a-z0-9-]*$/);
  }
});
