import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fixtureRows, platformName, runBrowser, main as playwrightMain } from '../playwright.mjs';
import { makeReport, validate, main as reportMain } from '../report.mjs';

const fixtures = { server_commit: 'fixture-commit', recipe_sha256: 'normaliser', items: [
    { id: 'sample', original: { file: 'original' }, playback: { file: 'playback' } },
] };
const key = row => `${row.item}|${row.rendition}|${row.variant}`;
const passRows = () => fixtureRows(fixtures).map(row => ({ ...row, outcome: 'pass',
    stages: { load: { ok: true, ms: 2 }, play: { ok: true, ms: 3 }, seek: null,
        replay: { ok: true, ms: 5 }, muted_autoplay: { ok: false, ms: 1, detail: 'no activation' } },
}));
const result = (runner = 'linux-chrome', rows = passRows()) => ({ runner,
    browser: { name: 'chrome', version: '123' }, os: { name: 'linux', version: '6' },
    started_at: 'start', finished_at: 'finish', rows,
});
async function directory(t) {
    const dir = await mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), '.r1-test-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return dir;
}

function stub({ launchError, gotoError, readyError, timeoutKey, clickErrorKey, postError = false } = {}) {
    const calls = [];
    let ready = false;
    let resolveReady;
    const snapshot = { ...result(), mode: 'auto', fixtures_commit: 'keep-me', user_agent: 'harness' };
    const page = {
        waitForEvent(name, options) {
            calls.push(['wait', name, options.timeout]);
            assert.equal(options.predicate({ text: () => 'other' }), false);
            assert.equal(options.predicate({ text: () => 'audio-matrix:ready' }), true);
            return new Promise((resolve, reject) => {
                resolveReady = () => { if (readyError) reject(new Error(readyError)); else { ready = true; resolve(); } };
            });
        },
        async goto(url) {
            calls.push(['goto', url]);
            if (gotoError) throw new Error(gotoError);
            setTimeout(resolveReady, 1);
        },
        async evaluate(fn, rowKey) {
            assert.equal(ready, true, 'no evaluation before muted pass');
            calls.push(['evaluate', rowKey]);
            // Invoke the callback, so tests exercise the actual window.__matrix API.
            const previous = globalThis.window;
            globalThis.window = { __matrix: {
                results: () => structuredClone(snapshot),
                done: value => value === timeoutKey ? new Promise(() => {}) : snapshot.rows.find(row => key(row) === value),
            } };
            try { return fn(rowKey); } finally { globalThis.window = previous; }
        },
        locator(selector) {
            return {
                async evaluateAll(fn) {
                    assert.equal(ready, true);
                    return fn(snapshot.rows.map(row => ({ getAttribute: () => key(row) })));
                },
                async click(options) {
                    calls.push(['click', selector, options]);
                    if (selector.includes(clickErrorKey || 'impossible-key')) throw new Error('click failed');
                },
            };
        },
    };
    const type = { async launch(options) {
        calls.push(['launch', options]);
        if (launchError) throw new Error(launchError);
        return { version: () => 'driver-version', async newContext(...args) {
            calls.push(['context', ...args]); return { newPage: async () => page };
        }, async close() { calls.push(['close']); } };
    } };
    const fetchFn = async (url, options) => {
        calls.push(['post', String(url), JSON.parse(options.body)]);
        return { ok: !postError, status: postError ? 503 : 200 };
    };
    return { calls, playwright: { chromium: type, firefox: type, webkit: type }, fetchFn };
}

for (const browserName of ['chrome', 'msedge', 'firefox', 'webkit', 'chromium']) {
    test(`${browserName}: console readiness, real ordered clicks, metadata, POST and disk`, async t => {
        const out = await directory(t);
        const fake = stub();
        const run = await runBrowser({ ...fake, browserName, manifest: fixtures, base: 'http://127.0.0.1:8765', out, platform: 'linux' });
        assert.equal(run.exitCode, 0);
        assert.deepEqual(validate(run.result), []);
        assert.deepEqual(fake.calls[0], ['launch', ['chrome', 'msedge'].includes(browserName) ? { channel: browserName } : {}]);
        assert.deepEqual(fake.calls[1], ['context']);
        assert.deepEqual(fake.calls[2], ['wait', 'console', 120_000]);
        const url = new URL(fake.calls[3][1]);
        assert.equal(url.searchParams.get('runner'), `linux-${browserName}`);
        assert.equal(url.searchParams.get('variants'), 'live,as-stored');
        assert.equal(url.searchParams.get('mode'), 'auto');
        assert.deepEqual(fake.calls.filter(call => call[0] === 'click').map(call => call[1]),
            passRows().map(row => `button[data-play=${JSON.stringify(key(row))}]`));
        assert.equal(run.result.fixtures_commit, 'keep-me');
        assert.equal(run.result.browser.version, 'driver-version');
        assert.equal(run.result.browser.name, browserName === 'webkit' ? 'WebKit (not Safari)' : browserName);
        assert.equal(run.result.rows[0].stages.muted_autoplay.detail, 'no activation');
        assert.deepEqual(JSON.parse(await readFile(path.join(out, `linux-${browserName}.json`), 'utf8')), run.result);
        assert.deepEqual(fake.calls.find(call => call[0] === 'post').slice(1), ['http://127.0.0.1:8765/results', run.result]);
    });
}
for (const fault of [{ launchError: 'channel not installed' }, { gotoError: 'navigation failed' }, { readyError: 'console timed out' }]) {
    test(`infrastructure row set: ${JSON.stringify(fault)}`, async t => {
        const run = await runBrowser({ ...stub(fault), browserName: 'chrome', manifest: fixtures,
            base: 'http://127.0.0.1:8765', out: await directory(t) });
        assert.equal(run.exitCode, 1);
        assert.equal(run.result.rows.length, 3);
        assert.ok(run.result.rows.every(row => row.outcome === 'infra'));
        assert.deepEqual(validate(run.result), []);
    });
}
test('40-second host deadline marks timed-out done as infra and continues clicking', async t => {
    const fake = stub({ timeoutKey: 'sample|playback|live' });
    const run = await runBrowser({ ...fake, browserName: 'chromium', manifest: fixtures,
        base: 'http://127.0.0.1:8765', out: await directory(t), rowTimeoutMs: 10 });
    assert.equal(run.exitCode, 1);
    assert.equal(run.result.rows[0].outcome, 'infra');
    assert.match(run.result.rows[0].error.message, /exceeded 10 ms/);
    assert.equal(run.result.rows[1].outcome, 'pass');
    assert.equal(fake.calls.filter(call => call[0] === 'click').length, 3);
});
test('click and publication failures remain visible and retain the local file', async t => {
    const out = await directory(t);
    const run = await runBrowser({ ...stub({ clickErrorKey: 'sample|playback|live', postError: true }),
        browserName: 'chromium', manifest: fixtures, base: 'http://127.0.0.1:8765', out });
    assert.equal(run.exitCode, 1);
    assert.equal(run.result.rows[0].outcome, 'infra');
    assert.match(run.result.runner_error, /503/);
    assert.deepEqual(JSON.parse(await readFile(path.join(out, `${run.result.runner}.json`), 'utf8')), run.result);
});
test('platform labels match CI', () => {
    assert.deepEqual(['darwin', 'win32', 'linux'].map(platformName), ['macos', 'windows', 'linux']);
});

test('schema validates local references, oneOf, required fields and numeric types', () => {
    assert.deepEqual(validate(result()), []);
    for (const mutate of [
        data => { delete data.browser.version; },
        data => { data.rows[0].stages.play.ms = 0.5; },
        data => { data.rows[0].stages.seek = { ok: 'yes', ms: 2 }; },
        data => { data.rows[0].outcome = 'skipped'; },
        data => { data.rows[0].duration = Infinity; },
        data => { data.rows[0].requests = [{ status: '206' }]; },
        data => { data.os = []; },
    ]) {
        const data = result(); mutate(data);
        assert.ok(validate(data).length > 0);
    }
    const nullable = result(); nullable.rows[0].duration = null;
    nullable.rows[0].stages.muted_autoplay = null;
    assert.deepEqual(validate(nullable), []);
});
test('report merges columns, orders required first and ignores muted autoplay for gating', () => {
    const report = makeReport([result(), { ...result('linux-webkit'), browser: { name: 'WebKit (not Safari)', version: '1' } }], { fixtures });
    assert.equal(report.exitCode, 0);
    assert.match(report.markdown, /^PASS: 1\/1 required checks passed/);
    assert.match(report.markdown, /WebKit \(not Safari\)/);
    assert.ok(report.markdown.indexOf('**Required**') < report.markdown.indexOf('sample / original'));
});
test('informational media failure is shown with reason without failing required checks', () => {
    const data = result(); data.rows[1].outcome = 'fail:media'; data.rows[1].error = { message: 'bad | codec\nmessage' };
    const report = makeReport([data], { fixtures });
    assert.equal(report.exitCode, 0);
    assert.match(report.markdown, /✗ fail:media/);
    assert.match(report.markdown, /bad &#124; codec message/);
    assert.match(report.markdown, /### Failures/);
});
test('report cannot hide missing fixtures, columns, duplicates or false required flags', () => {
    for (const [data, expect] of [
        [[result('linux-chrome', [])], []],
        [[result()], ['linux-firefox']],
        [[result(), result()], []],
        [[result('linux-chrome', [...passRows(), passRows()[0]])], []],
        [[result('linux-chrome', passRows().map(row => ({ ...row, required: false })))], []],
        [[], []],
    ]) assert.equal(makeReport(data, { fixtures, expect }).exitCode, 1);
    for (const outcome of ['fail:media', 'fail:policy', 'fail:stall', 'infra', 'missing']) {
        const data = result(); data.rows[0].outcome = outcome;
        assert.equal(makeReport([data], { fixtures }).exitCode, 1);
    }
});
test('CLI accepts CI filenames, --expect and rejects malformed input', async t => {
    const out = await directory(t);
    const manifest = JSON.parse(await readFile(new URL('../../fixtures/manifest.json', import.meta.url), 'utf8'));
    const data = result('linux-chrome', fixtureRows(manifest).map(row => ({ ...row, outcome: 'pass' })));
    const file = path.join(out, 'ci-linux-chrome.json');
    await writeFile(file, JSON.stringify(data));
    const execute = async args => {
        let stdout = '';
        const mock = t.mock.method(process.stdout, 'write', chunk => { stdout += chunk; return true; });
        try { return { status: await reportMain(args), stdout }; }
        finally { mock.mock.restore(); }
    };
    assert.equal((await execute([file, '--expect', 'linux-chrome'])).status, 0);
    const absent = await execute([file, '--expect', 'linux-firefox']);
    assert.equal(absent.status, 1);
    assert.match(absent.stdout, /Expected runner file missing: linux-firefox/);
    await writeFile(file, '{broken');
    assert.equal((await execute([file])).status, 1);
    await writeFile(file, JSON.stringify({ runner: 'invalid' }));
    assert.match((await execute([file])).stdout, /expected|required/);
});

test('runner CLI rejects remote servers and duplicate or unknown browsers before networking', async () => {
    await assert.rejects(playwrightMain(['--base', 'https://example.com']), /local HTTP server/);
    await assert.rejects(playwrightMain(['--browsers', 'chromium,chromium']), /unique/);
    await assert.rejects(playwrightMain(['--browsers', 'safari']), /unique/);
});
test('report handles schema-permitted error objects without assuming message type', () => {
    const data = result(); data.rows[0].outcome = 'infra'; data.rows[0].error = { message: 123 };
    assert.deepEqual(validate(data), []);
    const report = makeReport([data], { fixtures });
    assert.equal(report.exitCode, 1);
    assert.match(report.markdown, /infra: 123/);
});

test('informational columns (WebKit, bundled Chromium) never gate the run; --gate-all makes them gate', async () => {
    const webkit = { ...result('linux-webkit'), browser: { name: 'WebKit (not Safari)', version: '1' } };
    webkit.rows = webkit.rows.map(row => ({ ...row, outcome: 'infra' }));
    const report = makeReport([result(), webkit], { fixtures });
    assert.equal(report.exitCode, 0);
    assert.match(report.markdown, /^PASS: 1\/1 required checks passed/);
});
