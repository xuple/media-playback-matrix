/*
 * Media playback matrix harness.
 * Contract: CONTRACT.md; pass definition: README.md "What pass means".
 *
 * Vanilla ES2019, no build, no dependencies: it has to run unchanged on iOS 18 Safari, Android Chrome, Firefox and
 * Edge, under WebDriver/Playwright drivers (auto mode) and on real phones by hand (manual mode).
 *
 * Why it is shaped like this:
 * - iOS only treats play() as user-initiated when it is called synchronously inside the click handler, so the click
 *   handler creates the <audio>, sets src and calls play() before anything awaits. Loading is measured in parallel.
 * - iOS has a small decoder budget, so each row gets its own <audio>, created on demand and removed afterwards.
 * - Every stage has its own deadline so a hang shows up as fail:stall on that stage instead of a driver timeout.
 */
(function () {
  'use strict';

  var DEADLINE = { load: 8000, play: 5000, seek: 5000, replay: 14000, muted: 6000 };
  var PLAY_ADVANCE = 0.5;   // seconds of progress that count as "playing"
  var CHECK_ADVANCE = 0.3;  // seconds of progress after seek / replay / muted autoplay
  var SEEK_TO = 30;
  var VARIANTS = ['live', 'no-cache', 'as-stored'];
  var RENDITIONS = ['playback', 'original'];
  // no-cache is an informational Safari/iOS experiment, so it is opt-in via ?variants=; everything else shows by default.
  var DEFAULT_VARIANTS = ['live', 'as-stored'];

  var query = parseQuery(location.search);
  var mode = query.mode === 'auto' ? 'auto' : 'manual';
  var runner = query.runner || null;
  var root = document.documentElement;
  // A host page can set <html data-base="/some/path">; the Node server serves the page from its root, so fall back to
  // the page's directory there.
  var baseOverride = (root.dataset && root.dataset.base) || root.getAttribute('data-base') || window.__MATRIX_BASE__ || null;
  var base = stripSlash(baseOverride !== null ? String(baseOverride) : location.pathname.replace(/[^/]*$/, ''));
  // The Range log only exists on the Node server; a host page sets data-base.
  var wantRequests = !!runner && baseOverride === null;

  var startedAt = new Date().toISOString();
  var lastFinishedAt = null;
  var manifest = null;
  var rows = [];          // row state objects, in table order
  var byKey = {};
  var mutedPassRunning = false;
  var mutedPassAbort = false;
  var notesEl = null;

  function parseQuery(search) {
    var out = {};
    search.replace(/^\?/, '').split('&').forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf('=');
      var k = decodeURIComponent(i < 0 ? pair : pair.slice(0, i));
      var v = i < 0 ? '' : decodeURIComponent(pair.slice(i + 1).replace(/\+/g, ' '));
      out[k] = v;
    });
    return out;
  }
  function listParam(name, allowed, dflt) {
    if (!query[name]) return dflt.slice();
    return query[name].split(',').map(function (s) { return s.trim(); }).filter(function (s) {
      return allowed === null || allowed.indexOf(s) >= 0;
    });
  }
  function stripSlash(s) { return s.replace(/\/+$/, ''); }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function deferred() {
    var d = {};
    d.promise = new Promise(function (res) { d.resolve = res; });
    return d;
  }

  // ---- browser / OS identification (best effort; runners may overwrite with what the driver reports) ----
  function detectBrowser() {
    var ua = navigator.userAgent;
    var m;
    if ((m = ua.match(/EdgA?\/([\d.]+)/))) return { name: 'Edge', version: m[1] };
    if ((m = ua.match(/Firefox\/([\d.]+)/))) return { name: 'Firefox', version: m[1] };
    if ((m = ua.match(/FxiOS\/([\d.]+)/))) return { name: 'Firefox (iOS)', version: m[1] };
    if ((m = ua.match(/CriOS\/([\d.]+)/))) return { name: 'Chrome (iOS)', version: m[1] };
    if ((m = ua.match(/Chrome\/([\d.]+)/))) return { name: /Android/.test(ua) ? 'Chrome Android' : 'Chrome', version: m[1] };
    if (/AppleWebKit/.test(ua)) {
      m = ua.match(/Version\/([\d.]+)/);
      return { name: /Mobile/.test(ua) ? 'Mobile Safari' : 'Safari', version: m ? m[1] : 'unknown' };
    }
    return { name: 'unknown', version: 'unknown' };
  }
  function detectOs() {
    var ua = navigator.userAgent;
    var m;
    if ((m = ua.match(/(?:iPhone|CPU) OS (\d+(?:_\d+)*)/))) return { name: 'iOS', version: m[1].replace(/_/g, '.') };
    // iPadOS reports a Mac UA; touch points give it away.
    if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) {
      m = ua.match(/Version\/([\d.]+)/);
      return { name: 'iPadOS', version: m ? m[1] : 'unknown' };
    }
    if ((m = ua.match(/Android (\d+(?:\.\d+)*)/))) return { name: 'Android', version: m[1] };
    if ((m = ua.match(/Mac OS X (\d+(?:[_.]\d+)*)/))) return { name: 'macOS', version: m[1].replace(/_/g, '.') };
    if ((m = ua.match(/Windows NT ([\d.]+)/))) return { name: 'Windows', version: m[1] };
    if (/Linux/.test(ua)) return { name: 'Linux', version: 'unknown' };
    return { name: 'unknown', version: 'unknown' };
  }

  // ---- rows ----
  function mediaUrl(variant, id, rendition) {
    return base + '/f/' + encodeURIComponent(variant) + '/' + encodeURIComponent(id) + '/' + encodeURIComponent(rendition);
  }
  function buildRows() {
    var only = listParam('only', null, []);
    var renditions = listParam('renditions', RENDITIONS, RENDITIONS);
    var variants = listParam('variants', VARIANTS, DEFAULT_VARIANTS);
    manifest.items.forEach(function (item) {
      if (only.length && only.indexOf(item.id) < 0) return;
      RENDITIONS.forEach(function (rendition) {
        if (renditions.indexOf(rendition) < 0) return;
        VARIANTS.forEach(function (variant) {
          if (variants.indexOf(variant) < 0) return;
          if (variant === 'as-stored' && rendition !== 'original') return; // CONTRACT: as-stored is originals only
          var info = item[rendition] || {};
          var mime = rendition === 'playback' ? 'audio/mp4' : (variant === 'as-stored' ? item.stored_mime : info.mime);
          var r = {
            key: item.id + '|' + rendition + '|' + variant,
            item: item, rendition: rendition, variant: variant,
            mime: mime || '',
            expected: typeof info.duration === 'number' ? info.duration : null,
            // Used only to aim the replay seek when the browser reports no finite duration (MediaRecorder WebM).
            hint: typeof info.duration === 'number' ? info.duration
              : (item.playback && typeof item.playback.duration === 'number' ? item.playback.duration : null),
            check: (item.checks && item.checks.indexOf('seek') >= 0) ? 'seek' : 'replay',
            result: null, attempt: 0, running: false, muted: null, heard: null, played: false,
            waiters: deferred(), ui: {}
          };
          rows.push(r);
          byKey[r.key] = r;
        });
      });
    });
  }

  function blankResult(r) {
    return {
      item: r.item.id, rendition: r.rendition, variant: r.variant,
      required: r.rendition === 'playback' && r.variant === 'live',
      outcome: 'missing',
      can_play_type: '',
      stages: { load: null, play: null, seek: null, replay: null, muted_autoplay: null },
      duration: null, duration_check: null, error: null
    };
  }

  function rowResult(r) {
    var out = r.result ? JSON.parse(JSON.stringify(r.result)) : blankResult(r);
    if (!r.result) {
      out.can_play_type = canPlay(r.mime);
      // Schema requires stage objects when present; an unrun row has no load/play, so record them as not run.
      out.stages.load = { ok: false, ms: 0, detail: r.running ? 'running' : 'not run' };
      out.stages.play = { ok: false, ms: 0, detail: r.running ? 'running' : 'not run' };
    }
    out.stages.muted_autoplay = r.muted;
    if (mode === 'manual') out.heard = r.heard === null && r.played ? false : r.heard;
    return out;
  }

  function canPlay(mime) {
    try { return mime ? document.createElement('audio').canPlayType(mime) : ''; } catch (e) { return ''; }
  }

  // ---- stage helpers ----
  function StageError(cls, detail, error) {
    this.cls = cls; this.detail = detail; this.error = error || null;
  }
  function mediaErrorInfo(audio) {
    var e = audio.error;
    if (!e) return null;
    return { code: e.code, message: e.message || ['', 'MEDIA_ERR_ABORTED', 'MEDIA_ERR_NETWORK', 'MEDIA_ERR_DECODE',
      'MEDIA_ERR_SRC_NOT_SUPPORTED'][e.code] || '' };
  }
  function classifyRejection(audio, err) {
    var name = err && err.name ? err.name : 'Error';
    var msg = err && err.message ? err.message : String(err);
    if (name === 'NotAllowedError') return new StageError('fail:policy', 'play() rejected: NotAllowedError: ' + msg,
      { name: name, message: msg });
    var me = mediaErrorInfo(audio);
    // NotSupportedError (or AbortError after a failed load) means the media itself was refused.
    if (me || name === 'NotSupportedError') {
      return new StageError('fail:media', 'play() rejected: ' + name + ': ' + msg,
        me || { code: 4, message: name + ': ' + msg });
    }
    return new StageError('fail:media', 'play() rejected: ' + name + ': ' + msg, { name: name, message: msg });
  }

  /*
   * Resolve when check() is true; reject on a MediaError, a play() rejection seen via ctx, or the deadline.
   * Polls (cheap) as well as listening, because some engines are sparing with timeupdate.
   */
  function waitFor(ctx, audio, check, ms, what, ignoreReject) {
    return new Promise(function (resolve, reject) {
      var t0 = now();
      var timer = null, poll = null;
      function cleanup() {
        clearTimeout(timer); clearInterval(poll);
        ['loadedmetadata', 'playing', 'timeupdate', 'seeked', 'ended', 'error', 'canplay'].forEach(function (n) {
          audio.removeEventListener(n, tick);
        });
        ctx.onReject = null;
      }
      function tick() {
        if (audio.error) { cleanup(); reject(new StageError('fail:media', 'MediaError during ' + what, mediaErrorInfo(audio))); return; }
        if (ctx.rejected && !ignoreReject) { cleanup(); reject(classifyRejection(audio, ctx.rejected)); return; }
        var ok = false;
        try { ok = check(); } catch (e) { ok = false; }
        if (ok) { cleanup(); resolve(Math.round(now() - t0)); }
      }
      ['loadedmetadata', 'playing', 'timeupdate', 'seeked', 'ended', 'error', 'canplay'].forEach(function (n) {
        audio.addEventListener(n, tick);
      });
      ctx.onReject = ignoreReject ? null : tick;
      poll = setInterval(tick, 50);
      timer = setTimeout(function () {
        cleanup();
        reject(new StageError('fail:stall', 'no ' + what + ' within ' + ms + ' ms (readyState ' + audio.readyState +
          ', networkState ' + audio.networkState + ', t=' + round(audio.currentTime) +
          ', paused ' + audio.paused + ', ended ' + audio.ended + ', seeking ' + audio.seeking +
          ', play() ' + (ctx.rejected ? 'rejected' : (ctx.resolved ? 'resolved' : 'pending')) + ')'));
      }, ms);
      tick();
    });
  }
  function round(x) { return typeof x === 'number' && isFinite(x) ? Math.round(x * 1000) / 1000 : x; }

  // Calls play() and tracks the promise on ctx so a later rejection is classified by whichever stage is waiting.
  function startPlay(ctx, audio) {
    ctx.rejected = null;
    ctx.resolved = false;
    var p;
    try { p = audio.play(); } catch (e) { ctx.rejected = e; return; }
    if (p && typeof p.then === 'function') {
      p.then(function () { ctx.resolved = true; }, function (e) {
        ctx.rejected = e || new Error('play() rejected');
        if (ctx.onReject) ctx.onReject();
      });
    } else {
      ctx.resolved = true; // pre-promise engines: treat as accepted, progress still has to be seen
    }
  }

  function makeAudio(r, muted) {
    var a = document.createElement('audio');
    a.preload = 'metadata';
    a.setAttribute('playsinline', '');
    a.setAttribute('webkit-playsinline', '');
    if (muted) { a.muted = true; a.setAttribute('muted', ''); }
    a.src = mediaUrl(r.variant, r.item.id, r.rendition);
    (r.ui.audioSlot || document.body).appendChild(a);
    return a;
  }
  function disposeAudio(a) {
    try { a.pause(); } catch (e) { /* ignore */ }
    try { a.removeAttribute('src'); a.load(); } catch (e) { /* ignore */ }
    if (a.parentNode) a.parentNode.removeChild(a);
  }

  function durationCheck(r, d) {
    if (r.expected === null) return { check: 'n/a', ok: true, detail: 'duration ' + round(d) + ' (manifest has none; n/a)' };
    if (typeof d !== 'number' || !isFinite(d)) {
      return { check: 'not finite', ok: false, detail: 'duration ' + d + ', manifest ' + r.expected };
    }
    var tol = Math.max(0.25, r.expected * 0.02);
    var ok = Math.abs(d - r.expected) <= tol;
    return { check: ok ? 'ok' : 'off', ok: ok,
      detail: 'duration ' + round(d) + ' vs manifest ' + r.expected + ' (±' + round(tol) + ')' };
  }

  // ---- the gesture sequence ----
  function onPlayClick(ev) {
    var key = ev.currentTarget.getAttribute('data-play');
    var r = byKey[key];
    if (!r || r.running) return;
    if (mutedPassRunning) mutedPassAbort = true; // keep the decoder budget for the gesture run
    r.result = null;
    r.attempt += 1;
    r.running = true;
    r.played = true;
    var res = blankResult(r);
    res.attempt = r.attempt;
    res.can_play_type = canPlay(r.mime);
    var ctx = {};
    var audio, t0 = now();
    try {
      audio = makeAudio(r, false);
      startPlay(ctx, audio); // synchronous inside the click: this is the user gesture (iOS)
    } catch (e) {
      finishRow(r, res, null, 'infra', 'harness error before play(): ' + e);
      return;
    }
    setRowStatus(r, 'running…');
    runSequence(r, res, ctx, audio, t0).then(function () {
      finishRow(r, res, audio, 'pass');
    }, function (err) {
      if (err instanceof StageError) {
        res.error = err.error;
        finishRow(r, res, audio, err.cls, err.detail);
      } else {
        finishRow(r, res, audio, 'infra', 'harness error: ' + (err && err.stack ? err.stack : err));
      }
    });
  }

  function stageFail(res, name, t0, err) {
    res.stages[name] = { ok: false, ms: Math.round(now() - t0), detail: err.detail || String(err) };
    throw err;
  }

  async function runSequence(r, res, ctx, audio, t0) {
    // load: loadedmetadata within 8 s of the click.
    try {
      // A play() rejection is a play-stage fact (policy vs media), so the load stage only watches metadata/errors.
      var loadMs = await waitFor(ctx, audio, function () { return audio.readyState >= 1; }, DEADLINE.load, 'loadedmetadata', true);
      var dc = durationCheck(r, audio.duration);
      res.duration = typeof audio.duration === 'number' && isFinite(audio.duration) ? round(audio.duration) : null;
      res.duration_check = dc.check;
      res.stages.load = { ok: dc.ok, ms: loadMs, detail: dc.detail };
      // A copy that reports the wrong length breaks the scrubber; that is a media fault, not a stall.
      if (!dc.ok) throw new StageError('fail:media', 'load: ' + dc.detail, null);
    } catch (e) {
      if (!res.stages.load) stageFail(res, 'load', t0, e);
      throw e;
    }

    // play: promise resolved, currentTime advanced ≥ 0.5 s, within 5 s of metadata.
    var tPlay = now();
    var startT = audio.currentTime || 0;
    try {
      var playMs = await waitFor(ctx, audio, function () {
        return ctx.resolved && !audio.paused && audio.currentTime - startT >= PLAY_ADVANCE;
      }, DEADLINE.play, 'playback progress of ' + PLAY_ADVANCE + ' s');
      res.stages.play = { ok: true, ms: playMs, detail: 't=' + round(audio.currentTime) };
    } catch (e) { stageFail(res, 'play', tPlay, e); }

    if (r.check === 'seek') await seekCheck(res, ctx, audio);
    else await replayCheck(r, res, ctx, audio);
  }

  /*
   * The pass definition asks for a resolved play() promise on the play stage only; seek and replay are judged on progress. That
   * matters on Playwright WebKit (Linux, 20 Nov 2026): after a seek it plays on while readyState stays at 2, so the
   * second play() promise never settles. A rejection still fails the stage; a pending promise is only noted.
   */
  function promiseNote(ctx) { return ctx.resolved ? '' : ' (play() promise still pending)'; }

  // 60 s items: pause, jump to 30 s, wait for seeked, play, and see ≥ 0.3 s of progress from 30 s.
  async function seekCheck(res, ctx, audio) {
    var t0 = now();
    try {
      audio.pause();
      var seekedFlag = false;
      var onSeeked = function () { seekedFlag = true; };
      audio.addEventListener('seeked', onSeeked);
      audio.currentTime = SEEK_TO;
      await waitFor(ctx, audio, function () { return seekedFlag && !audio.seeking; }, DEADLINE.seek, 'seeked');
      audio.removeEventListener('seeked', onSeeked);
      var landed = audio.currentTime;
      if (Math.abs(landed - SEEK_TO) > 1) {
        throw new StageError('fail:media', 'seek landed at ' + round(landed) + ', asked for ' + SEEK_TO, null);
      }
      var left = DEADLINE.seek - (now() - t0);
      startPlay(ctx, audio);
      // Measured from where it actually landed, and only while playing: a seek
      // that lands past 30 s must not pass without moving (Codex review, 20 Nov 2026).
      await waitFor(ctx, audio, function () {
        return !audio.paused && !audio.seeking && audio.currentTime >= landed + CHECK_ADVANCE;
      }, Math.max(left, 1), 'progress from ' + round(landed) + ' s');
      res.stages.seek = { ok: true, ms: Math.round(now() - t0),
        detail: 'seeked to ' + round(landed) + ', t=' + round(audio.currentTime) + promiseNote(ctx) };
    } catch (e) { stageFail(res, 'seek', t0, e); }
  }

  // 12 s items: jump near the end, play to `ended`, then play again from 0 (the no-store refetch question).
  async function replayCheck(r, res, ctx, audio) {
    var t0 = now();
    res.replay_path = 'play-after-ended';
    var onRewindSeeked = null;
    try {
      var d = audio.duration;
      var target = (typeof d === 'number' && isFinite(d)) ? d - 1 : (r.hint ? r.hint - 1 : null);
      if (target === null) throw new StageError('fail:media', 'no duration to aim the replay seek at', null);
      var endedFlag = false;
      var onEnded = function () { endedFlag = true; };
      audio.addEventListener('ended', onEnded);
      audio.currentTime = Math.max(0, target);
      if (audio.paused) startPlay(ctx, audio);
      await waitFor(ctx, audio, function () { return endedFlag || audio.ended; }, DEADLINE.replay, 'ended after seeking to ' + round(target));
      audio.removeEventListener('ended', onEnded);
      var left = DEADLINE.replay - (now() - t0);
      // 1. What the app's player does: play() after `ended` (the spec restarts from 0). No new gesture is needed on
      //    the same element.
      // 2. Only if that doesn't move: rewind, WAIT for `seeked`, then play(). Rewinding and calling play() at once
      //    races in WebKit (play() resolves, then the element is paused and ended again at t=0; CI 21 Nov 2026).
      // The detail says which one worked: if 2 is needed on a platform, the app's player needs it too.
      var replayed = function () { return !audio.paused && !audio.ended && audio.currentTime >= CHECK_ADVANCE && audio.currentTime < 5; };
      var how = 'play() after ended';
      startPlay(ctx, audio);
      try {
        await waitFor(ctx, audio, replayed, Math.max(Math.min(left, 5000), 1), 'progress after play() following ended');
      } catch (first) {
        if (first.cls !== 'fail:stall') throw first;
        res.replay_path = 'rewind-fallback';
        how = 'rewind fallback; app play-after-ended path did not work: ' + first.detail;
        audio.pause();
        var rewindSeeked = false;
        onRewindSeeked = function () { rewindSeeked = true; };
        audio.addEventListener('seeked', onRewindSeeked);
        audio.currentTime = 0;
        await waitFor(ctx, audio, function () { return rewindSeeked && !audio.seeking; },
          Math.max(DEADLINE.replay - (now() - t0), 1), 'seeked after rewind');
        audio.removeEventListener('seeked', onRewindSeeked);
        onRewindSeeked = null;
        startPlay(ctx, audio);
        await waitFor(ctx, audio, replayed, Math.max(DEADLINE.replay - (now() - t0), 1), 'progress after rewind + seeked + play()');
      }
      res.stages.replay = { ok: true, ms: Math.round(now() - t0),
        replay_path: res.replay_path,
        detail: 'ended, replayed to t=' + round(audio.currentTime) + ' · ' + how + promiseNote(ctx) };
    } catch (e) {
      try { stageFail(res, 'replay', t0, e); }
      finally { res.stages.replay.replay_path = res.replay_path; }
    } finally {
      if (onEnded) audio.removeEventListener('ended', onEnded);
      if (onRewindSeeked) audio.removeEventListener('seeked', onRewindSeeked);
    }
  }

  function finishRow(r, res, audio, outcome, detail) {
    res.outcome = outcome;
    // The schema wants stage objects for load/play and for the row's own check; stages after a failure were not reached.
    ['load', 'play', r.check].forEach(function (n) {
      if (!res.stages[n]) res.stages[n] = { ok: false, ms: 0, detail: 'not reached' };
    });
    if (outcome !== 'pass' && detail) res.detail = detail;
    if (audio) disposeAudio(audio);
    lastFinishedAt = new Date().toISOString();
    var after = wantRequests ? fetchRequests(r.item.id) : Promise.resolve(null);
    after.then(function (reqs) {
      if (reqs) res.requests = reqs;
      r.result = res;
      r.running = false;
      renderRow(r);
      renderSummary();
      var w = r.waiters;
      r.waiters = deferred(); // a manual re-run gets a fresh promise; done() returns the latest
      r.lastDone = Promise.resolve(rowResult(r));
      w.resolve(rowResult(r));
    });
  }

  // The server log is cumulative per item (all renditions, variants and the muted pass), so each fetch keeps only the
  // entries added since the previous fetch for that item. Rows run one at a time, so that slice is this row's.
  var requestsSeen = {};
  function fetchRequests(id) {
    return fetch('/requests?item=' + encodeURIComponent(id), { cache: 'no-store' }).then(function (resp) {
      return resp.ok ? resp.json() : null;
    }).then(function (j) {
      if (!Array.isArray(j)) return null;
      var from = requestsSeen[id] || 0;
      requestsSeen[id] = j.length;
      return j.slice(from).map(function (x) {
        return { range: x.range === undefined ? null : x.range, status: x.status | 0, bytes: x.bytes | 0 };
      });
    }).catch(function () { return null; });
  }

  // ---- muted autoplay (auto mode, no gesture, non-gating) ----
  // muted_autoplay only means "without a gesture" if the page has never had user activation. Drivers can grant it
  // without a click (Playwright's page.evaluate runs as a user gesture in Chromium, seen 20 Nov 2026), so every
  // muted result says whether the page was already activated; drivers should wait for the 'audio-matrix:ready' console line.
  function activationNote() {
    var ua = navigator.userActivation;
    if (!ua) return ' · page activation unknown';
    return ua.hasBeenActive ? ' · page already had user activation (not a clean no-gesture test)' : ' · no user activation';
  }
  async function mutedOne(r) {
    var ctx = {};
    var note = activationNote();
    var audio = makeAudio(r, true);
    var t0 = now();
    try {
      startPlay(ctx, audio);
      await waitFor(ctx, audio, function () { return audio.readyState >= 1; }, DEADLINE.muted, 'loadedmetadata');
      var s = audio.currentTime || 0;
      await waitFor(ctx, audio, function () {
        return ctx.resolved && !audio.paused && audio.currentTime - s >= CHECK_ADVANCE;
      }, Math.max(DEADLINE.muted - (now() - t0), 1), 'muted progress');
      r.muted = { ok: true, ms: Math.round(now() - t0), detail: 't=' + round(audio.currentTime) + note };
    } catch (e) {
      r.muted = { ok: false, ms: Math.round(now() - t0), detail: (e && e.cls ? e.cls + ': ' : '') + (e && e.detail ? e.detail : String(e)) + note };
    }
    try { audio.pause(); audio.currentTime = 0; } catch (e) { /* reset before removal */ }
    disposeAudio(audio);
    if (wantRequests) await fetchRequests(r.item.id); // advance the per-item offset past the muted pass's requests
    renderRow(r);
  }
  // Start after `load` and a painted frame so the pass measures the settled page, not boot-time races.
  function afterLoad() {
    return new Promise(function (resolve) {
      function frames() { requestAnimationFrame(function () { requestAnimationFrame(function () { resolve(); }); }); }
      if (document.readyState === 'complete') frames();
      else window.addEventListener('load', frames);
    });
  }
  async function mutedPass() {
    mutedPassRunning = true;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (mutedPassAbort || r.running || r.played) {
        r.muted = { ok: false, ms: 0, detail: 'skipped: a row was clicked before the muted pass finished' };
        renderRow(r);
        continue;
      }
      await mutedOne(r);
    }
    mutedPassRunning = false;
  }

  // ---- results ----
  function results() {
    var out = {
      runner: runner || (mode === 'manual' ? 'manual' : 'unnamed'),
      mode: mode,
      browser: detectBrowser(),
      os: detectOs(),
      device: root.getAttribute('data-device') || null,
      started_at: startedAt,
      finished_at: lastFinishedAt || new Date().toISOString(),
      server_commit: root.getAttribute('data-server-commit') || null,
      recipe_sha256: manifest ? (manifest.recipe_sha256 || null) : null,
      fixtures_recipe: manifest ? (manifest.generated_by || null) : null,
      user_agent: navigator.userAgent,
      rows: rows.map(rowResult)
    };
    if (mode === 'manual') {
      out.device_info = deviceInfo();
      out.notes = notesEl ? notesEl.value : '';
    }
    return out;
  }
  function deviceInfo() {
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform || '',
      screen: screen.width + '×' + screen.height + ' @' + (window.devicePixelRatio || 1) + 'x'
    };
  }
  function summaryText() {
    var res = rows.map(rowResult);
    var req = res.filter(function (x) { return x.required; });
    var reqPass = req.filter(function (x) { return x.outcome === 'pass'; });
    var reqFail = req.filter(function (x) { return x.outcome !== 'pass' && x.outcome !== 'missing'; });
    var reqMissing = req.filter(function (x) { return x.outcome === 'missing'; });
    var parts = [reqPass.length + '/' + req.length + ' voice copies played'];
    if (reqFail.length) parts.push(reqFail.length + ' voice copies failed: ' + reqFail.map(label).join(', '));
    if (reqMissing.length) parts.push(reqMissing.length + ' voice copies not tried');
    var info = res.filter(function (x) { return !x.required; });
    var infoFail = info.filter(function (x) { return x.outcome !== 'pass' && x.outcome !== 'missing'; });
    var infoPass = info.filter(function (x) { return x.outcome === 'pass'; });
    if (info.length) {
      parts.push(infoPass.length + '/' + info.length + ' other rows played' +
        (infoFail.length ? '; ' + infoFail.length + ' failed: ' + infoFail.map(label).join(', ') : ''));
    }
    if (mode === 'manual') {
      var heard = res.filter(function (x) { return x.heard === true; }).length;
      var played = res.filter(function (x) { return x.outcome !== 'missing'; }).length;
      parts.push('heard ' + heard + ' of ' + played + ' tried');
    }
    return parts.join('; ') + '.';
  }
  function label(x) {
    var tags = [];
    if (x.rendition === 'original') tags.push('original');
    if (x.variant !== 'live') tags.push(x.variant);
    return x.item + (tags.length ? ' (' + tags.join(', ') + ')' : '') + ' ' + x.outcome;
  }

  function done(key, minAttempt) {
    var r = byKey[key];
    if (!r) return Promise.reject(new Error('unknown row ' + key));
    minAttempt = minAttempt || 1;
    if (!r.running && r.result && r.attempt >= minAttempt) return Promise.resolve(rowResult(r));
    return r.waiters.promise.then(function (result) {
      return result.attempt >= minAttempt ? result : done(key, minAttempt);
    });
  }

  // ---- rendering ----
  var MARK = { ok: '✓', bad: '✗' };
  function stageText(s) {
    if (s === null || s === undefined) return '—';
    return (s.ok ? MARK.ok + ' ok' : MARK.bad + ' failed') + ' ' + s.ms + ' ms';
  }
  function outcomeText(o) {
    if (o === 'pass') return MARK.ok + ' pass';
    if (o === 'missing') return 'not run';
    return MARK.bad + ' ' + o;
  }
  function setRowStatus(r, text) {
    r.ui.outcome.textContent = text;
    r.ui.btn.disabled = true;
  }
  function setCell(td, s) {
    td.textContent = stageText(s);
    td.title = s && s.detail ? s.detail : '';
    td.className = s ? (s.ok ? 'ok' : 'bad') : '';
  }
  function renderRow(r) {
    var res = r.result;
    var ui = r.ui;
    if (!ui.tr) return;
    ui.cpt.textContent = res ? (res.can_play_type || '""') : (canPlay(r.mime) || '""');
    setCell(ui.load, res ? res.stages.load : null);
    setCell(ui.play, res ? res.stages.play : null);
    setCell(ui.check, res ? (r.check === 'seek' ? res.stages.seek : res.stages.replay) : null);
    setCell(ui.muted, r.muted);
    if (!r.muted && mode === 'manual') ui.muted.textContent = 'n/a';
    if (r.running) return;
    ui.outcome.textContent = res ? outcomeText(res.outcome) : 'not run';
    ui.outcome.className = res ? (res.outcome === 'pass' ? 'ok' : 'bad') : '';
    ui.detail.textContent = res && res.outcome !== 'pass' ? (res.detail || '') : '';
    ui.btn.disabled = false;
    ui.btn.textContent = res ? 'Play again' : 'Play';
  }

  // A host page may provide <div id="matrix">; create it if not.
  function mountPoint() {
    var m = document.getElementById('matrix');
    if (!m) { m = el('div', { id: 'matrix' }); document.body.appendChild(m); }
    return m;
  }

  function render() {
    var app = mountPoint();
    app.innerHTML = '';
    var head = el('div', { 'class': 'intro' });
    head.appendChild(el('p', null, mode === 'auto'
      ? 'Automatic mode: a driver clicks each Play button.'
      : 'Tap each Play button and listen. Tick “I heard it” if you heard the voice clearly. ' +
        'When you have finished, press “Copy results” and send them to us.'));
    if (mode === 'manual') {
      var di = deviceInfo();
      head.appendChild(el('p', { 'class': 'device', id: 'device-line' },
        'Device: ' + di.userAgent + ' · platform ' + (di.platform || 'unknown') + ' · screen ' + di.screen));
    }
    app.appendChild(head);

    var table = el('table', { 'class': 'matrix', id: 'matrix-table' });
    var thead = el('thead');
    var hr = el('tr');
    ['Recording', 'Play', 'Can play type', 'Load', 'Play', 'Seek / replay', 'Muted autoplay', 'Outcome']
      .concat(mode === 'manual' ? ['I heard it'] : [])
      .forEach(function (h) { hr.appendChild(el('th', { scope: 'col' }, h)); });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = el('tbody');
    rows.forEach(function (r) {
      var tr = el('tr', { 'data-row': r.key, 'class': r.rendition + ' ' + r.variant });
      var name = el('th', { scope: 'row', 'data-label': 'Recording' });
      name.appendChild(el('span', { 'class': 'name' }, r.item.name || r.item.id));
      name.appendChild(el('span', { 'class': 'sub' },
        (r.rendition === 'playback' ? 'voice copy' : 'original') + ' · ' + r.variant +
        (r.rendition === 'playback' && r.variant === 'live' ? ' · must pass' : '') + ' · ' + r.check));
      tr.appendChild(name);
      var tdBtn = el('td', { 'class': 'cell-btn' });
      var btn = el('button', { type: 'button', 'data-play': r.key, 'class': 'play' }, 'Play');
      btn.addEventListener('click', onPlayClick);
      tdBtn.appendChild(btn);
      var slot = el('span', { 'class': 'audio-slot', 'aria-hidden': 'true' });
      tdBtn.appendChild(slot);
      tr.appendChild(tdBtn);
      r.ui = { tr: tr, btn: btn, audioSlot: slot };
      [['cpt', 'Can play type'], ['load', 'Load'], ['play', 'Play'], ['check', r.check === 'seek' ? 'Seek' : 'Replay'],
        ['muted', 'Muted autoplay'], ['outcome', 'Outcome']].forEach(function (c) {
        var td = el('td', { 'data-label': c[1] });
        r.ui[c[0]] = td;
        tr.appendChild(td);
      });
      r.ui.detail = el('span', { 'class': 'detail' });
      var outCell = r.ui.outcome;
      r.ui.outcome = el('span', { 'class': 'outcome' });
      outCell.appendChild(r.ui.outcome);
      outCell.appendChild(r.ui.detail);
      if (mode === 'manual') {
        var td = el('td', { 'class': 'cell-heard' });
        var lab = el('label', { 'class': 'heard' });
        var cb = el('input', { type: 'checkbox', 'data-heard': r.key });
        cb.addEventListener('change', function () { r.heard = cb.checked; renderSummary(); });
        lab.appendChild(cb);
        lab.appendChild(document.createTextNode(' I heard it'));
        td.appendChild(lab);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
      renderRow(r);
    });
    table.appendChild(tbody);
    app.appendChild(table);

    var foot = el('div', { 'class': 'foot' });
    foot.appendChild(el('p', { id: 'summary', 'class': 'summary', 'aria-live': 'polite' }));
    if (mode === 'manual') {
      var nl = el('label', { 'for': 'notes', 'class': 'notes-label' },
        'Notes (anything odd: silent switch, Low Power Mode, lock screen, AirPods…)');
      notesEl = el('textarea', { id: 'notes', rows: '4' });
      foot.appendChild(nl);
      foot.appendChild(notesEl);
      var copy = el('button', { type: 'button', id: 'copy-results', 'class': 'copy' }, 'Copy results');
      copy.addEventListener('click', copyResults);
      foot.appendChild(copy);
      foot.appendChild(el('p', { id: 'copy-status', 'class': 'copy-status', 'aria-live': 'polite' }));
    }
    app.appendChild(foot);
    renderSummary();
  }
  function renderSummary() {
    var s = document.getElementById('summary');
    if (s) s.textContent = summaryText();
  }

  function copyResults() {
    var text = summaryText() + '\n\n' + JSON.stringify(results(), null, 2);
    var status = document.getElementById('copy-status');
    function fallback() {
      var ta = document.getElementById('copy-fallback');
      if (!ta) {
        ta = el('textarea', { id: 'copy-fallback', rows: '10', readonly: '' });
        status.parentNode.insertBefore(ta, status.nextSibling);
      }
      ta.value = text;
      ta.focus();
      ta.select();
      var copied = false;
      try { copied = document.execCommand('copy'); } catch (e) { copied = false; }
      status.textContent = copied ? 'Copied. The results are also in the box below.'
        : 'Could not copy automatically: select all the text in the box below and copy it.';
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        status.textContent = 'Copied to the clipboard.';
      }, fallback);
    } else {
      fallback();
    }
  }

  // ---- boot ----
  var readyResolve, readyReject;
  var ready = new Promise(function (res, rej) { readyResolve = res; readyReject = rej; });
  window.__matrix = { ready: ready, results: results, done: done, mode: mode, base: base };

  function boot() {
    fetch(base + '/manifest.json', { cache: 'no-store' }).then(function (resp) {
      if (!resp.ok) throw new Error('manifest.json: HTTP ' + resp.status);
      return resp.json();
    }).then(function (m) {
      manifest = m;
      buildRows();
      render();
      // In auto mode the muted pass runs before the drivers start clicking (CONTRACT: "then waits for clicks"),
      // so ready waits for it: two decoders fighting would make both signals worse.
      return mode === 'auto' ? afterLoad().then(mutedPass) : null;
    }).then(function () {
      // A DOM marker lets drivers wait without page.evaluate (which can grant user activation, see activationNote).
      root.setAttribute('data-matrix-ready', '1');
      // Playwright's waitForSelector/waitForFunction poll with injected script, which also counts as user activation
      // (Chromium and WebKit, 20 Nov 2026); a console line can be awaited with no page script at all.
      if (window.console && console.info) console.info('audio-matrix:ready');
      readyResolve(true);
    }, function (e) {
      var app = mountPoint();
      app.textContent = 'Could not start the check: ' + e.message;
      readyReject(e);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
