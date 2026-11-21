// Exercise the real driver loop with the fake harness without requiring a listening socket.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { driveMatrix, identifyAndroid, identifySafari } from '../../lib/drive.mjs';
import { WebDriver } from '../../lib/webdriver.mjs';
import { createPage } from './fake-wd.mjs';

const stall = stage => ({ outcome: 'fail:stall', stages: {
    load: { ok: stage !== 'load', ms: 1 }, play: { ok: !['load', 'play'].includes(stage), ms: 1 },
    seek: stage === 'seek' ? { ok: false, ms: 1 } : null,
    replay: { ok: false, ms: 1, detail: stage === 'replay' ? 'no seeked after rewind' : 'not reached' },
} });
async function run(t, { simulator = false, android = false, rows = [], disconnects = [], missedRetry = false } = {}) {
    const keys = ['one|playback|live', 'two|playback|live', 'three|playback|live'];
    const clicks = [], waits = [];
    let page, sessions = 0, deletes = 0;
    const mock = (name, fn) => t.mock.method(WebDriver.prototype, name, fn);
    mock('newSession', async () => { sessions++; page = createPage({ buttons: keys, attemptRows: { [keys[0]]: rows } });
        return { capabilities: { browserVersion: '26.2', platformVersion: '14' } }; });
    mock('deleteSession', async () => { deletes++; });
    mock('setTimeouts', async () => {});
    mock('navigate', async () => {});
    mock('findElement', async selector => /data-play="([^"]+)"/.exec(selector)[1]);
    const click = async key => {
        clicks.push(key);
        if (!(missedRetry && clicks.filter(k => k === key).length === 2)) page.state.clicks.push(key);
    };
    mock('click', click); mock('tap', click);
    const execute = (script, args = []) => vm.compileFunction(script, [], { parsingContext: vm.createContext({
        window: page.window, document: page.document, navigator: page.navigator, Promise,
    }) }).apply(null, args);
    mock('executeScript', async (script, args) => JSON.parse(JSON.stringify(execute(script, args))));
    mock('executeAsyncScript', async (script, args = []) => {
        if (script.includes('matrix.done')) {
            waits.push(args);
            if (disconnects.some(([session, key]) => session === sessions && key === args[0])) throw new Error('disconnected: not connected to DevTools');
            if (missedRetry && args[1] === 2) throw new Error('attempt 2 timeout');
        }
        return await new Promise(resolve => execute(script, [...args, resolve]));
    });
    t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 200 }));
    const work = await mkdtemp(path.join(tmpdir(), 'matrix-recovery-'));
    t.after(() => rm(work, { recursive: true, force: true }));
    const result = await driveMatrix({ webdriverUrl: 'http://fake', capabilities: simulator ? { 'safari:useSimulator': true } : {},
        navigateBase: 'http://fake', resultsBase: 'http://fake', outDir: work,
        identify: android ? identifyAndroid : identifySafari, recoverDisconnect: android, log() {} });
    return { ...result, clicks, waits, sessions, deletes, keys };
}

test('simulator retries once, preserves both attempts and waits for attempt 2', async t => {
    const r = await run(t, { simulator: true, rows: [stall('replay'), {}] });
    assert.equal(r.results.rows[0].outcome, 'pass');
    assert.deepEqual(r.results.rows[0].attempts.map(row => row.outcome), ['fail:stall', 'pass']);
    assert.deepEqual(r.waits.slice(0, 2).map(args => args[1]), [1, 2]);
    assert.equal(r.results.rows[0].attempt, 2);
});
test('second simulator stall remains a failure', async t => {
    const r = await run(t, { simulator: true, rows: [stall('replay'), stall('replay')] });
    assert.equal(r.results.rows[0].outcome, 'fail:stall');
    assert.equal(r.results.rows[0].attempts.length, 2);
    assert.equal(r.exitCode, 1);
});
test('a missed second tap cannot reuse the first result', async t => {
    const r = await run(t, { simulator: true, rows: [stall('replay')], missedRetry: true });
    assert.equal(r.results.rows[0].outcome, 'infra');
    assert.deepEqual(r.results.rows[0].attempts.map(row => row.outcome), ['fail:stall', 'infra']);
});
for (const [name, options, first] of [
    ['desktop', {}, stall('replay')], ['Android', { android: true }, stall('replay')],
    ...['load', 'play', 'seek'].map(stage => [stage, { simulator: true }, stall(stage)]),
    ...['fail:media', 'fail:policy', 'infra'].map(outcome => [outcome, { simulator: true }, { ...stall('replay'), outcome }]),
]) test(`${name} is not eligible for a row retry`, async t => {
    const r = await run(t, { ...options, rows: [first] });
    assert.equal(r.clicks.length, 3);
    assert.equal(r.results.rows[0].attempts, undefined);
});
for (const twice of [false, true]) test(`Android restart ${twice ? 'stops after second disconnect' : 'preserves completed rows'}`, async t => {
    const key = 'two|playback|live';
    const r = await run(t, { android: true, disconnects: [[1, key], ...(twice ? [[2, key]] : [])] });
    assert.equal(r.sessions, 2); assert.equal(r.deletes, 2);
    assert.equal(r.results.session_restarts, 1);
    assert.deepEqual(r.results.rows.map(row => row.outcome), twice ? ['pass', 'infra', 'infra'] : ['pass', 'pass', 'pass']);
    assert.deepEqual(r.results.rows.map(row => !!row.session_restarted), [false, true, true]);
    assert.equal(r.clicks.filter(key => key === r.keys[0]).length, 1);
    assert.equal(r.clicks.length, twice ? 3 : 4);
});
