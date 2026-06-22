# safelight-registry

The trust registry for [Safelight](https://github.com/anthonyreimche/SafeLight) extensions.

Safelight extensions are ordinary GitHub repos (tagged `safelight-extension`) that
install straight from source and run with full access to your photos, metadata and
edits. This registry is the curation layer on top of that: a human-reviewed
**allowlist** and a remote **kill-switch**, both plain JSON the app fetches on launch.
No backend, no accounts — just two files reviewed through pull requests.

## Files

| File | Purpose |
|------|---------|
| [`verified.json`](verified.json) | Repos a maintainer has reviewed. Shown with a green **✓ Verified** badge in the Extensions store and installed without the unverified-risk prompt. |
| [`banned.json`](banned.json) | Repos / accounts refused at install **and** disabled at load — even if already installed. The kill-switch. |

The app reads these from `raw.githubusercontent.com/anthonyreimche/safelight-registry/main/`,
caches them for ~6 hours, and falls back to the last-known-good copy if a fetch fails
(so a registry outage never un-bans anything or blocks installs).

## Getting your extension verified

1. Make sure your repo has a valid `safelight.json` and is tagged `safelight-extension`.
2. Open a pull request adding your repo to `verified.json`:
   ```json
   { "verified": ["your-account/your-extension"] }
   ```
3. A maintainer reviews the extension's code, then merges. Within a few hours every
   client shows your extension as verified.

Verification is a code review, not an endorsement — it means "a human looked at this
and it isn't doing anything malicious," nothing more.

## Reporting / banning a malicious extension

Open an issue (or a PR straight to `banned.json`) with the repo and what it does. Ban a
specific repo, or a whole account for a typosquatter / compromised owner:

```json
{
  "repos":  ["baduser/evil-ext"],
  "owners": ["spammer-account"],
  "reason": { "baduser/evil-ext": "exfiltrates EXIF GPS to a remote host" }
}
```

Once merged, the next launch (or the next 6-hour refresh) disables it everywhere,
including on machines where it was already installed. No app release required.

## Format notes

- All entries are case-insensitive `owner/repo` or bare `owner`.
- The `_comment` field in each file is ignored by the app — it's just a note for readers.
- Users can turn on **Preferences ▸ Extensions ▸ Only verified extensions** to refuse
  anything not in `verified.json`. Bans always apply regardless of that setting.
