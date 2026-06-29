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

The app reads these from `raw.githubusercontent.com/anthonyreimche/safelight-registry/main/`,
caches them for ~6 hours, and falls back to the last-known-good copy if a fetch fails
(so a registry outage never un-bans anything or blocks installs).

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
