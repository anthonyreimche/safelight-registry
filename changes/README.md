# Pending registry requests

Each file here is one request, `<issue number>.json`, added by the pull
request that the request's issue opened (see `requests.mjs`). Once merged,
the Apply registry requests workflow (`apply-changes.mjs`) folds it into
`verified.json`, `banned.json`, `deprecated.json` or
`category-overrides.json` and deletes it. One file per request means two open
requests never edit the same file.
