# Media playback matrix contract
The interfaces every part codes against. Fixtures + manifest: `fixtures/` (generated; do not edit by hand).

## Layout
- `fixtures/originals/*`, `fixtures/playback/*.m4a`, `fixtures/manifest.json` — items[] with `id`, `name`, `checks`
  (`["seek"]` for items of 45 s or more, `["replay"]` otherwise), `stored_mime`, `original{file,mime,duration,...}`,
  `playback{file,mime,mode,duration,...}` (or `{error}`). Made by `bin/make-originals.sh` + `bin/make-playback.mjs`.
- `harness/index.html`, `harness/harness.js`, `harness/harness.css` (vanilla ES2019, no build, no deps).
- `server/server.mjs` (Node ≥ 20, no deps).
- `lib/*.mjs` (minimal WebDriver client, Safari/simulator and Android Chrome drivers).
- `runners/playwright.mjs`, `runners/safari-webdriver.mjs`, `runners/android-chrome.mjs`, `runners/report.mjs`,
  `runners/ci.mjs`.
- `.github/workflows/matrix.yml`.

## URLs (the bundled server and any host page use the same shape)
- Harness: `/` (server) or `<base>/` on a host page. Query: `?mode=auto|manual&runner=<label>&only=<id,id>&renditions=playback,original&variants=live,no-cache,as-stored`.
- Media: `<base>/f/<variant>/<item-id>/<rendition>` — extensionless. `variant` ∈ `live` (audio/mp4 for playback,
  manifest `original.mime` for originals; `private, no-store`), `no-cache` (same but `private, no-cache`),
  `as-stored` (Content-Type = manifest `stored_mime`; originals only). `rendition` ∈ `playback|original`.
- Manifest for the harness: `<base>/manifest.json`.
- Results (server only, loopback): `POST /results` body = Results JSON; server writes `out/<runner>.json`.
- Server also exposes `GET /requests?item=<id>` → the Range log for that item (array of {range, status, bytes}).

## Harness API (window.__matrix)
- `window.__matrix.ready` (Promise) resolves when the manifest is loaded and the table rendered.
- Each item × rendition × variant row has a Play button: `button[data-play="<id>|<rendition>|<variant>"]`.
  Clicking it runs the full gesture sequence (play → seek or replay) for that row; the click IS the gesture.
- `window.__matrix.results()` → Results JSON so far; `window.__matrix.done(rowKey)` → Promise of that row's result.
- auto mode: runs `muted_autoplay` per row without clicks, then waits for clicks (drivers click each button in order).
- Drivers: for each row key, click, then `await window.__matrix.done(key)` (or poll `results()`), max 40 s per row.

## Results JSON (results.schema.json is authoritative)
{ "runner": "safari-macos", "browser": {"name","version"}, "os": {"name","version"}, "device": "iPhone 16 (sim) | null",
  "started_at", "finished_at", "server_commit", "recipe_sha256",
  "rows": [ { "item": "<id>", "rendition": "playback|original", "variant": "live|no-cache|as-stored",
              "required": true|false, "outcome": "pass|fail:media|fail:policy|fail:stall|infra|missing",
              "can_play_type": "", "stages": { "load": {...}, "play": {...}, "seek": {...}|null, "replay": {...}|null,
              "muted_autoplay": {...} }, "duration": 12.0, "error": {"code":4,"message":""}|null,
              "requests": [ {"range":"bytes=0-1","status":206,"bytes":2} ] } ] }
Stage object: { "ok": bool, "ms": int, "detail": string }.
required = rendition playback AND variant live.
