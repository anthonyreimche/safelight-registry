# safelight-registry

The trust registry for [Safelight](https://github.com/anthonyreimche/SafeLight) extensions.

Safelight extensions are ordinary GitHub repos (tagged `safelight-extension`) that
install straight from source and run with **full access to your photos, metadata,
edits and files**. This registry is a best-effort curation layer on top of that: a
human-reviewed **allowlist** and a remote **kill-switch**, both plain JSON the app
fetches on launch. No backend, no accounts — just two files reviewed through pull
requests.

It is a community safety aid, **not a guarantee**. See [Scope & disclaimer](#scope--disclaimer).

## Files

| File | Purpose |
|------|---------|
| [`verified.json`](verified.json) | Repos a maintainer has code-reviewed at a point in time. Shown with a **✓ Verified** badge in the Extensions store and installed without the unverified-risk prompt. |
| [`banned.json`](banned.json) | Repos / accounts assessed as malicious: refused at install **and** disabled at load, even if already installed. The kill-switch. |
| `registry.json` | The store's **browse catalog** — auto-generated, do not hand-edit. See [Registry index](#registry-index-registryjson). |
| [`categories.json`](categories.json) | The Extensions store's categories: slug, label, description, aliases, and the type badges. Hand-edited. See [Store categories](#store-categories-categoriesjson). |
| [`category-overrides.json`](category-overrides.json) | Categories for repos whose authors haven't tagged one. Used only when the repo has no purpose topic and no matching manifest categories. |

The app reads these from `raw.githubusercontent.com/anthonyreimche/safelight-registry/main/`,
caches them for ~6 hours, and falls back to the last-known-good copy if a fetch fails
(so a registry outage never un-bans anything or blocks installs).

## Registry index (`registry.json`)

The Extensions store's **Browse** tab loads a single prebuilt catalog of every
published extension — name, description, stars, dates, topics, a resolved
thumbnail, and the store's own grouping (categories, type badge, keywords,
screenshots and Works with links) — instead of running a live GitHub search and
scraping each repo's preview image on every machine. That makes the store open in one CDN request, show
the *complete* list (not the search API's first 25), and power the New / Popular /
Recently-updated / Featured shelves.

That catalog is `registry.json`, built by [`build-registry.mjs`](build-registry.mjs)
and committed automatically by the
[Build registry index](.github/workflows/build-registry.yml) workflow. It runs on a
schedule (hourly), on demand (the **Run workflow** button), and whenever
`verified.json`, `banned.json`, `categories.json`, `category-overrides.json`,
`store-fields.mjs` or the generator change. Banned repos/owners are
excluded at build time as well as enforced live.

**Setup (one time):** in the repo's **Settings ▸ Actions ▸ General ▸ Workflow
permissions**, choose **Read and write permissions** so the job can commit the
regenerated file. No secrets needed — it uses the built-in `GITHUB_TOKEN`.

The app fetches it from `cdn.jsdelivr.net/gh/anthonyreimche/safelight-registry/registry.json`
(CDN-cached ~1h; the store's ↻ pulls the un-cached `raw.githubusercontent` copy),
and falls back to a live GitHub search if the index is ever unreachable.

`registry.json` is **generated — never edit it by hand**; change `build-registry.mjs`
instead. To preview locally before committing:

```sh
GITHUB_TOKEN=<a classic PAT, no scopes needed> node build-registry.mjs   # writes ./registry.json
```

## Version records

Each `registry.json` entry also says which version Safelight should offer, so
the app's update checks never call the GitHub API (60 requests an hour without
sign-in):

- `latest`: the newest full GitHub Release whose `safelight.json` at the tag
  agrees with the tag — `{ version, tag, from: "release", zips, minAppVersion? }`,
  where `zips` lists up to three of the release's own `.zip` downloads. A repo
  with no releases gets `{ version, from: "branch", minAppVersion? }` from its
  default branch's `safelight.json`.
- `prerelease`: present only when a pre-release is newer than `latest`.
- `releaseError`: replaces both when the repo has full releases but none agrees
  with its manifest (for example `"v1.3.0: safelight.json says 1.2.0"`).

A repo with only pre-releases gets none of these, and the app asks GitHub
itself. If GitHub can't be read for a repo during a build, its fields from the
previous build are kept. The build commits only when the catalog's content
changed, not on every run just because `generatedAt` moved.

## What "verified" means — and doesn't

Verification is a **point-in-time code review**: a maintainer looked at the repo's code
as it existed at review time and didn't find it doing anything malicious. That is *all*
it means.

- It is **not** an endorsement, a safety guarantee, or a warranty.
- Extensions install and update from the repo's latest code. When a verified entry is
  **pinned to a version** (the preferred form below), the app flags any newer published
  version as unreviewed until it is re-reviewed; an unpinned entry cannot detect this.
- A verified extension still runs with full access. Apply the same judgement you would
  to any third-party software.

## Getting your extension verified

1. Make sure your repo has a valid `safelight.json` and is tagged `safelight-extension`.
2. Open a pull request adding your repo to `verified.json`. Two forms are accepted:
   ```json
   {
     "verified": [
       "your-account/your-extension",
       { "repo": "your-account/your-extension", "version": "1.2.0", "commit": "a1b2c3d" }
     ]
   }
   ```
   - A bare `"owner/repo"` string verifies the repo but is **not pinned** to a version.
   - The **object form is preferred**: `version` (and optionally `commit`) records the
     exact point a maintainer reviewed. The app shows a plain green badge only while the
     repo's published version matches the reviewed one; once the repo publishes a newer
     version, that version is treated as **unreviewed** — an amber badge plus an
     install/update prompt — until it is re-reviewed.
3. A maintainer reviews the extension's code, then merges. Within a few hours every
   client reflects it.

When you ship a new version, open a PR bumping the `version` (and `commit`) so the
update is covered by verification again.

## Reporting a malicious extension

Open an issue (or a PR straight to `banned.json`) with the repo and what it does. Ban a
specific repo, or a whole account for a typosquatter / compromised owner:

```json
{
  "repos":  ["baduser/evil-ext"],
  "owners": ["spammer-account"],
  "reason": { "baduser/evil-ext": "v1.2 uploads photo EXIF GPS to an external host without disclosure" }
}
```

The `reason` text is **shown to users**, so describe the **observed behavior
specifically and factually** — ideally with the version, commit, or file — not a
character judgement. Once merged, the next launch (or the next 6-hour refresh) disables
it everywhere, including on machines where it was already installed. No app release
required.

## Moderation policy (good faith)

- Bans are made in **good faith** to protect users, based on the information available
  at the time, and each ban reason is the **registry's assessment** of observed
  behavior — not a personal accusation against an author.
- **Appeals & corrections:** if you believe a ban is mistaken, or you have fixed the
  issue, open an issue or email **anthonyreimche@gmail.com**. Bans are reversed promptly
  once the problem is corrected or shown to be a false positive.
- **Whole-account** bans are reserved for clear cases (typosquatting, or a
  compromised/hijacked account) and are lifted the same way.
- Listing, verification, and removal are at the maintainer's discretion. This is a free,
  best-effort service offered to help users, and may change or stop at any time.

## Scope & disclaimer

This registry is provided **as-is, with no warranty of any kind**, as a best-effort
community safety tool. It **cannot** guarantee that a verified extension is safe, or
that every malicious extension is listed. Extensions are independent third-party
software and their authors are responsible for them. Users should rely on their own
judgement and may enable **Preferences ▸ Extensions ▸ Only verified extensions** for a
stricter allowlist.

## Format notes

- All entries are case-insensitive `owner/repo` or bare `owner`.
- The `_comment` field in each file is ignored by the app — it's just a note for readers.
- Users can turn on **Preferences ▸ Extensions ▸ Only verified extensions** to refuse
  anything not in `verified.json`. Bans always apply regardless of that setting.

## Starter kits (`kits.json`)

The Safelight welcome setup offers **starter kits**: groups of verified
extensions by shooting style that people can install on first launch. The app
fetches `kits.json` from this repo (raw.githubusercontent, cached for an hour),
so kits change without an app release.

```json
{
  "schema": 1,
  "kits": [
    {
      "id": "film",
      "name": "Film looks",
      "description": "Film stock simulation and alternative tone rendering.",
      "icon": "film",
      "extensions": [
        { "repo": "owner/repo", "name": "Manifest name", "summary": "One line.", "minAppVersion": "3.0.0" }
      ]
    }
  ]
}
```

Rules (checked by `validate-kits.mjs` in CI, and again by the app):

- `id`: lowercase letters, digits and `-`, at most 32 characters, unique.
- `name` 1–40 characters, `description` up to 160; extension `name` 1–48 (use
  the extension's manifest name), `summary` up to 140.
- `icon`: one of `film`, `palette`, `detail`, `organise`, `speed`, `import`,
  `style`.
- Every `repo` must be in `verified.json`, present in `registry.json`, and not
  banned; listed once per kit. Kits may share repos.
- At most 8 kits and 12 extensions per kit.
- `minAppVersion` (optional, `x.y.z`) hides the extension in older app builds.
- Only `"schema": 1` is read. A breaking format change must ship as a new file
  name so released apps keep reading this one.

Run `node --test validate-kits.test.mjs && node validate-kits.mjs` before
pushing a change.

## Store categories (`categories.json`)

The Extensions store groups extensions by what they are for. Each category has
a topic, `safelight-<slug>`:

| Topic | Category |
|---|---|
| `safelight-library` | Library |
| `safelight-metadata` | Metadata |
| `safelight-tone` | Tone |
| `safelight-color` | Colour |
| `safelight-look` | Looks |
| `safelight-detail` | Detail and repair |
| `safelight-workflow` | Workflow |
| `safelight-export` | Export and sharing |
| `safelight-preset` | Presets |
| `safelight-theme` | Themes and interface |

An extension gets at most three, decided in this order:

1. **`categories` in its `safelight.json`**, when any value names a category by
   slug, label or alias (any case): `"categories": ["Detail", "Tone"]`. Values
   that name none (for example "Develop") are ignored and listed in the build
   log.
2. **Its `safelight-<slug>` topics**, in the order of the table above.
3. **`category-overrides.json`**, which a maintainer fills in for repos that
   have neither. An author's own topics or manifest always win.

With none of these it shows under **Other**.

`safelight-module`, `safelight-pipeline` and `safelight-panel` are not
categories: the store shows the first one present as a badge (Module,
Processing, Panel).

The builder also copies, from the default branch's `safelight.json`:

- `keywords`: searched by the store (at most 20, each up to 40 characters);
- `screenshots`: https URLs or repo-relative paths of at most 2048 characters,
  shown on the detail page (at most 6). The manifest `icon` follows the same
  rules. jsDelivr serves repo-relative screenshots from the default branch
  and caches them for up to a week, so give a changed screenshot a new file name;
- `worksWith`: `"owner/repo"` extensions it pairs well with (at most 6). The
  link shows on this extension's page, and on the other extension's page too
  when this one is verified.

Rules for `categories.json` (checked by `validate-categories.mjs` in CI and by
the builder): slugs match `^[a-z][a-z0-9-]{0,23}$`, are unique, and aren't
`home` or `other` (the store uses those); labels are
1–24 characters, descriptions 1–140; no slug, label or alias may stand for two
categories; type slugs differ from category slugs; at most 16 categories.
Overrides name `owner/repo` once each, with 1–3 known slugs, none repeated.

Run `node --test store-fields.test.mjs validate-categories.test.mjs build-registry.test.mjs && node validate-categories.mjs`
before opening a pull request.
