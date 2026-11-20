# Media playback matrix

**Does this file actually play here?** Codec checkers ask a browser whether it *could* play a format
(`canPlayType`, Media Capabilities). That is a prediction, and it is often wrong for real files: a WebM voice note
recorded by Chrome's MediaRecorder has no duration or cues, and Safari on iPhone and iPad refuses it even though it
"supports" Opus. This project loads real files, served the way production servers serve them (Range requests,
extensionless URLs, `no-store`), starts them with a **real click**, and checks that playback starts, the length is
right, seeking works and a finished clip replays, in every browser GitHub's hosted runners can drive: Safari, the
iPhone and iPad simulators, Chrome, Edge and Firefox on macOS, Windows and Linux, and Chrome on Android.

It ships with synthetic fixtures (computer speech, no real voices) covering what browsers and phones record or
upload, and a reference recipe that turns any of them into a copy that plays everywhere (AAC-LC in a faststart
MP4). Audio today; video and images next.

## Use it for your own files

1. Put your files in `fixtures/originals/`, or regenerate the samples with `bin/make-originals.sh`
   (needs ffmpeg built with libflite, libopus and libmp3lame; Debian's package has them).
2. Make the playable copies and the manifest with the reference recipe: `node bin/make-playback.mjs`.
   To test your own converter instead, write `fixtures/playback/<name>.m4a` yourself and run
   `node bin/make-playback.mjs --manifest-only`.
3. Run locally (below), or push to a fork: the workflow runs the full matrix on GitHub's free runners for public
   repositories.

The manifest records each file's SHA256, codec, container and duration, the recipe's SHA256 and the ffmpeg
version, so a result always names exactly what was tested.

## What pass means

For each required playback copy served with the `live` headers:

- Metadata loads within 8 seconds. A finite duration agrees with the manifest
  within the greater of 0.25 seconds and 2%.
- A driver clicks the actual Play button. The `play()` promise resolves, `playing`
  arrives within 5 seconds and playback advances at least 0.5 seconds.
- A 60-second item seeks to 30 seconds, emits `seeked` within 5 seconds, then
  advances at least 0.3 seconds from that position.
- A short item reaches `ended` (the harness may seek to its final second), then
  replays from zero and advances at least 0.3 seconds.

`can_play_type` is only a hint. Muted autoplay is measured separately and does not
contribute to pass. CI measures playback events and time; it never claims that a
person heard audio. Originals lacking a container duration have a duration check
of `n/a`.

The bundled server serves files the way a typical application server does: extensionless URLs, Range
requests (rules modelled on Symfony's BinaryFileResponse, including its multi-range and invalid-range
behaviour), `audio/mp4` for playback, `private, no-store`, nosniff and inline delivery.
Originals use the informational `as-stored` variant. Safari and iOS also exercise
`no-cache` playback as an informational experiment.

## Columns

| Column | Host / device | Required? |
| --- | --- | --- |
| Safari (safaridriver) | Standard `macos-15` | Yes |
| iOS Safari simulator | iOS 26.2 iPhone | Yes |
| iOS Safari simulator | iOS 26.2 iPad | Yes |
| iOS Safari simulator | iOS 18.6 iPhone | Yes |
| Chrome stable | macOS, Windows, Linux | Yes, each host |
| Edge stable | macOS, Windows | Yes, each host |
| Firefox | macOS, Windows, Linux | Yes, each host |
| Android Chrome | API 34, Play Store x86_64 image, KVM | Yes |
| WebKit (not Safari) | macOS, Linux | Informational |
| Bundled Playwright Chromium | Linux | Informational |

Simulator types and UDIDs are discovered from `simctl` JSON, and simulators run
one at a time. Missing runtimes produce `infra` rows and fail the required gate;
there is no silent skip or runtime substitution. Android must contain
`com.android.chrome`; there is no APK fallback. Browser, OS and runtime versions
are included in runner results and platform diagnostics.

## Run locally

Requires Node 20 or newer. From the repository root, install the runner dependency and browsers:

```sh
npm install --prefix runners --ignore-scripts --no-audit --no-fund
(cd runners && npx playwright install --with-deps chromium firefox webkit)
```

Playwright is pinned in `runners/package.json`. Chrome stable and Edge are separate
channels, not aliases for bundled Chromium. Install the needed channels with
`(cd runners && npx playwright install chrome msedge)` on a supported host.

Start the local server in one terminal:

```sh
node server/server.mjs --port 8765
```

In another terminal, from the same directory:

```sh
node runners/ci.mjs wait
node runners/playwright.mjs --browsers chromium,firefox,webkit
# With Chrome stable installed:
node runners/playwright.mjs --browsers chrome,firefox,webkit,chromium
node runners/report.mjs out/*.json > report.md
```

Use `http://127.0.0.1:8765/?mode=manual` for manual clicks. Stop the server with
Ctrl-C afterwards. Browser downloads require network access during setup;
playback tests use the local server and synthetic fixtures. Never add autoplay
policy bypass flags: the real click is part of the measurement.

## Read the report

`report.md` is a table of fixture/rendition/variant rows against browser columns,
with must-pass rows first. Each runner JSON retains the individual load, play,
seek, replay and muted-autoplay stages, duration, errors and media Range log.

| Outcome | Meaning |
| --- | --- |
| `pass` | The required playback sequence completed |
| `fail:media` | A media/decoder error (inspect code and message) |
| `fail:policy` | `play()` was rejected by playback policy |
| `fail:stall` | A stage exceeded its deadline or time did not advance |
| `infra` | Driver, browser, runtime or job infrastructure was unavailable |
| `missing` | An expected result was not recorded |

A full CI run must contain every manifest playback/live row for every required
column. `infra` and `missing` fail it. Informational originals, no-cache experiments,
muted autoplay, WebKit and bundled Chromium do not gate the playback matrix.
A reporting error still fails the report job.

The workflow runs on push, Mondays at 05:00 UTC, and manual dispatch. Result and
diagnostic artifacts are retained for 14 days. The report job runs even after
upstream failures, fills missing columns and rows, appends Markdown to the job
summary, uploads `merged-results.json` (a `results` array of per-runner schema
objects plus `required_pass`) and exits non-zero on required failures. Raw runner
files are retained in diagnostic artifacts; `ci-*.json` uses stable column labels
and preserves the original runner label in `source_runner`.

Before trusting a full run, dispatch with `spike: true`. This runs verbose Safari
and iOS 26.2 iPhone session checks on macOS, including default Xcode selection and
`DEVELOPER_DIR=/Applications/Xcode_26.2.app/Contents/Developer`, and the Android
Play Store/Chrome driver check on Linux. Two jobs are necessary because each job
has one host OS; there is no matrix expansion. Full browser jobs and their report
are skipped. Inventory and per-Xcode session JSON are kept as diagnostics. Inspect
both spike jobs; a missing runtime or failed session is a failed spike. The spike
uses the existing runners' sessions, so it may exercise more than one fixture.

## Test on real phones

Simulators use Apple's media stack but not real hardware or real audio output. Serve the harness from any HTTPS
host (or your own app, by setting `<html data-base="/your/path">` on a page that loads `harness.js` and
`harness.css` and serves the same URL shape; see CONTRACT.md) and open `?mode=manual` on the device. Tap Play on
each row, tick "I heard it", seek and replay, then "Copy results". Silent switch, Low Power Mode,
lock/background/resume and Bluetooth headphones are worth noting by hand. Keep these results separate from CI.

## Licence

MIT. See [LICENSE](LICENSE).
