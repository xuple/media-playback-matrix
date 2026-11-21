import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../harness/harness.js', import.meta.url), 'utf8');
function harness(audioFactory = () => ({})) {
    const context = vm.createContext({
        location: { search: '', pathname: '/' }, navigator: { userAgent: '' },
        document: { documentElement: { dataset: {}, getAttribute() { return null; } }, readyState: 'loading',
            addEventListener() {}, createElement: audioFactory, getElementById() { return null; },
            body: { appendChild() {} } },
        window: {}, performance, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    });
    vm.runInContext(source.replace('replay: 14000', 'replay: 200').replace('Math.min(left, 5000)', 'Math.min(left, 40)')
        .replace('  // ---- boot ----', `
  window.test = { replayCheck: replayCheck, done: done, click: onPlayClick,
    setRow: function (r) { byKey[r.key] = r; },
    sequence: function (fn) { runSequence = fn; } };
  // ---- boot ----`), context);
    return context.window.test;
}
function audio({ seeked = true, progress = true, media = false } = {}) {
    const events = new Map();
    let time = 1;
    let plays = 0;
    const a = {
        duration: 12, paused: false, ended: false, seeking: false, readyState: 4, networkState: 1,
        addEventListener(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
        removeEventListener(name, fn) { events.get(name)?.delete(fn); },
        pause() { a.paused = true; },
        play() {
            plays++;
            a.paused = false;
            a.ended = true;
            time = 0;
            if (media) return Promise.reject({ name: 'NotAllowedError', message: 'denied' });
            if (plays > 1 && progress) { a.ended = false; time = 0.4; }
            return Promise.resolve();
        },
        get currentTime() { return time; },
        set currentTime(t) {
            time = t;
            if (t > 5) { a.ended = true; }
            if (t === 0 && seeked) queueMicrotask(() => { for (const fn of events.get('seeked') || []) fn(); });
        },
        plays: () => plays,
        listeners: () => [...events.values()].reduce((count, set) => count + set.size, 0),
    };
    return a;
}

test('rewind fallback requires a real seeked and labels app path failure', async () => {
    const api = harness();
    const a = audio();
    const res = { stages: {} };
    await api.replayCheck({}, res, {}, a);
    assert.equal(res.replay_path, 'rewind-fallback');
    assert.equal(res.stages.replay.ok, true);
    assert.match(res.stages.replay.detail, /app play-after-ended path did not work/);
    assert.equal(a.listeners(), 0);
});

test('missing seeked is a bounded replay stall; no timer pretends it happened', async () => {
    const api = harness();
    const a = audio({ seeked: false });
    const res = { stages: {} };
    await assert.rejects(api.replayCheck({}, res, {}, a), error => error.cls === 'fail:stall' && /no seeked after rewind/.test(error.detail));
    assert.equal(a.plays(), 1);
    assert.equal(res.stages.replay.replay_path, 'rewind-fallback');
    assert.equal(a.listeners(), 0);
});

test('failed replay records the illegal ended at zero state', async () => {
    const a = audio({ progress: false });
    const res = { stages: {} };
    await assert.rejects(harness().replayCheck({}, res, {}, a), error =>
        error.cls === 'fail:stall' && /t=0, paused false, ended true/.test(error.detail));
    assert.equal(res.stages.replay.ok, false);
});

test('policy rejection does not enter rewind fallback', async () => {
    const a = audio({ media: true });
    const res = { stages: {} };
    await assert.rejects(harness().replayCheck({}, res, {}, a), error => error.cls === 'fail:policy');
    assert.equal(res.replay_path, 'play-after-ended');
    assert.equal(a.plays(), 1);
});

test('a fresh click clears the old result and done waits for attempt 2', async () => {
    let created = 0;
    const api = harness(() => { created++; return { setAttribute() {}, canPlayType() { return ''; },
        play() { return Promise.resolve(); }, pause() {}, removeAttribute() {}, load() {} }; });
    const key = 'clip|playback|live';
    const r = { key, item: { id: 'clip' }, rendition: 'playback', variant: 'live', attempt: 1,
        result: { outcome: 'fail:stall', attempt: 1 }, running: false, check: 'replay',
        ui: { outcome: {}, btn: {} }, waiters: {} };
    r.waiters.promise = new Promise(resolve => { r.waiters.resolve = resolve; });
    api.setRow(r);
    let finish;
    api.sequence(() => new Promise(resolve => { finish = resolve; }));
    let settled = false;
    const waiting = api.done(key, 2).then(result => { settled = true; return result; });
    await Promise.resolve();
    assert.equal(settled, false); // missed tap cannot consume the previous failure
    api.click({ currentTarget: { getAttribute() { return key; } } });
    assert.equal(r.result, null);
    assert.equal(r.attempt, 2);
    assert.equal(settled, false);
    finish();
    const second = await waiting;
    assert.equal(second.attempt, 2);
    assert.equal(second.outcome, 'pass');
    assert.equal(created, 1); // fresh playback element
});
