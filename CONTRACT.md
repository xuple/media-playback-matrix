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

## Bounded recovery evidence

A new Play click clears the row result and increments its `attempt` (starting at 1), creating a fresh audio element.
`done(key, minAttempt = 1)` waits for that attempt or later; an old result cannot satisfy `done(key, 2)`.
Replay records `replay_path` on the row and replay stage: `play-after-ended` or `rewind-fallback`.
The fallback pauses, rewinds to zero, and requires a real `seeked` within the remaining replay deadline.
Missing `seeked` is `fail:stall` with detail `no seeked after rewind` and the element state; fallback success explicitly
says the app play-after-ended path did not work. Media and policy failures do not enter the fallback.

Only sessions requested with `safari:useSimulator: true` retry a replay-stage `fail:stall`, once, with a fresh tap.
The row retains the second outcome and `attempts: [first, second]` summaries, including stages and errors.
Desktop, Playwright and Android never use this row retry; load, play and seek stalls and media/policy/infra failures
are not eligible. More than one required retried row in a simulator column fails the merge and report gates.

Android alone rebuilds a disconnected WebDriver session once (including `unable to send message to renderer` and
`not connected to DevTools`). Completed rows are preserved; interrupted and remaining rows run in the new session
and carry `session_restarted: true`. A second disconnect marks remaining rows `infra`. Top-level `session_restarts`
counts session rebuilds, not affected rows; more than one fails the Android column gate. Reports show `✓ retry` or
`✓ restart` and counts per column. Recovered passes remain `outcome: "pass"` and do not prove first-attempt reliability.
