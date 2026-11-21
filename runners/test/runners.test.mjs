// Drives the Safari and Android Chrome runners against the fake WebDriver.
// Date: 2026-11-20. Owner: audio-matrix R2.
// No safaridriver, no emulator: the fake serves the endpoints and the page state.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

import { CFT_MILESTONES_URL, assertChromeInstalled, extractZipEntry, pickChromedriverDownload, resolveChromedriver } from '../../lib/chromedriver.mjs';
import { ANDROID_CHROME_ARGS, ROW_TIMEOUT_MS } from '../../lib/drive.mjs';
import { WebDriver, WebDriverError } from '../../lib/webdriver.mjs';
import { run as runAndroid } from '../android-chrome.mjs';
import { run as runSafari } from '../safari-webdriver.mjs';
import { startFakeWebDriver } from './fake-wd.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAFARI_CLI = path.join(HERE, '..', 'safari-webdriver.mjs');
const ANDROID_CLI = path.join(HERE, '..', 'android-chrome.mjs');

const KEYS = [
    'voice-memo|playback|live',
    'voice-memo-60s|playback|live',
    'upload|original|as-stored',
];

function readRequestBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];

        request.on('data', (chunk) => chunks.push(chunk));
        request.on('error', reject);
        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
}

async function startResultsSink() {
    const posts = [];
    const server = createServer(async (request, response) => {
        if (request.method === 'POST' && request.url === '/results') {
            posts.push(JSON.parse(await readRequestBody(request)));
            response.writeHead(204);
            response.end();

            return;
        }

        response.writeHead(404);
        response.end();
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    return {
        posts,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((resolve) => server.close(resolve)),
    };
}

async function makeWorkDir() {
    return mkdtemp(path.join(tmpdir(), 'audio-matrix-r2-'));
}

function runNode(script, args, env) {
    const child = spawn(process.execPath, [script, ...args], {
        env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
        stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
        stderr += chunk;
    });

    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => resolve({ code, stdout, stderr }));
    });
}

function crc32(buffer) {
    let crc = 0xffffffff;

    for (let i = 0; i < buffer.length; i += 1) {
        crc ^= buffer[i];

        for (let k = 0; k < 8; k += 1) {
            crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
    }

    return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const file of files) {
        const name = Buffer.from(file.name);
        const compressed = file.method === 0 ? file.data : deflateRawSync(file.data);
        const local = Buffer.alloc(30);
        const checksum = crc32(file.data);

        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(file.method, 8);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(file.data.length, 22);
        local.writeUInt16LE(name.length, 26);
        locals.push(local, name, compressed);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(file.method, 10);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(file.data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += local.length + name.length + compressed.length;
    }

    const centralBuf = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(files.length, 8);
    end.writeUInt16LE(files.length, 10);
    end.writeUInt32LE(centralBuf.length, 12);
    end.writeUInt32LE(offset, 16);

    return Buffer.concat([...locals, centralBuf, end]);
}

test('the row cap is 40 seconds', () => {
    assert.equal(ROW_TIMEOUT_MS, 40_000);
});

test('webdriver client reports the driver error code', { timeout: 15_000 }, async () => {
    const fake = await startFakeWebDriver({
        failSession: { error: 'session not created', message: 'Unable to find the simulator' },
    });

    try {
        const driver = new WebDriver(fake.url, { commandTimeoutMs: 2_000 });

        await assert.rejects(
            () => driver.newSession({ browserName: 'safari' }),
            (error) => {
                assert.ok(error instanceof WebDriverError);
                assert.equal(error.code, 'session not created');
                assert.match(error.message, /Unable to find the simulator/);
                assert.match(error.message, /POST \/session/);

                return true;
            },
        );
    } finally {
        await fake.close();
    }
});

test('webdriver client times out with a clear error when the driver never answers', { timeout: 15_000 }, async () => {
    const server = createServer(() => {});

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
        const driver = new WebDriver(`http://127.0.0.1:${port}`, { commandTimeoutMs: 200 });

        await assert.rejects(
            () => driver.newSession({ browserName: 'safari' }),
            (error) => {
                assert.ok(error instanceof WebDriverError);
                assert.equal(error.code, 'timeout');
                assert.match(error.message, /timed out after 200 ms/);

                return true;
            },
        );
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('webdriver client clicks, runs scripts, and deletes the session', { timeout: 15_000 }, async () => {
    const fake = await startFakeWebDriver({
        buttons: ['voice-memo|playback|live'],
        returnedCapabilities: { browserVersion: '18.6' },
    });

    try {
        const driver = new WebDriver(fake.url, { commandTimeoutMs: 2_000 });
        const session = await driver.newSession({ browserName: 'safari' });

        assert.equal(typeof session.sessionId, 'string');
        await driver.navigate('http://127.0.0.1/harness');
        const id = await driver.findElement('button[data-play="voice-memo|playback|live"]');
        await driver.click(id);
        const keys = await driver.executeScript(
            'var nodes = document.querySelectorAll("button[data-play]"); var out = []; for (var i = 0; i < nodes.length; i++) out.push(nodes[i].getAttribute("data-play")); return out;',
        );
        const echoed = await driver.executeAsyncScript(
            'const done = arguments[arguments.length - 1]; done(arguments[0]);',
            ['ok'],
            { timeoutMs: 1_000 },
        );

        assert.deepEqual(keys, ['voice-memo|playback|live']);
        assert.equal(echoed, 'ok');
        assert.deepEqual(fake.page.state.clicks, ['voice-memo|playback|live']);
        await driver.deleteSession();
        assert.equal(fake.sessions().length, 0);
        assert.ok(fake.log.some((entry) => entry.method === 'DELETE'));
    } finally {
        await fake.close();
    }
});

test('safari macos runner: caps, DOM click order, 40 s script cap, posted results', { timeout: 15_000 }, async () => {
    const fake = await startFakeWebDriver({
        buttons: KEYS,
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_0_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/1.0 Safari/605.1.15',
        returnedCapabilities: {
            browserVersion: '18.6',
            platformName: 'macOS',
            platformVersion: '15.1',
        },
    });
    const sink = await startResultsSink();
    const work = await makeWorkDir();

    try {
        const result = await runSafari({
            target: 'safari',
            udid: 'ignored-on-desktop',
            base: sink.url,
            out: work,
            driverUrl: fake.url,
            lockPath: path.join(work, 'safari.lock'),
        });
        const session = fake.log.filter((entry) => entry.method === 'POST' && entry.path === '/session');

        assert.equal(session.length, 1);
        assert.deepEqual(session[0].body, {
            capabilities: { alwaysMatch: { browserName: 'safari' } },
        });
        assert.equal(fake.page.state.clicks.length, KEYS.length);
        assert.deepEqual(fake.page.state.clicks, KEYS);
        assert.equal(fake.sessions().length, 0);
        assert.equal(fake.log.filter((entry) => entry.method === 'DELETE').length, 1);

        const navigations = fake.log.filter((entry) => entry.path.endsWith('/url')).map((entry) => entry.body.url);
        const harness = new URL(navigations.at(-1));

        assert.equal(navigations.length, 1);
        assert.equal(harness.origin, sink.url);
        assert.equal(harness.hostname, '127.0.0.1');
        assert.equal(harness.searchParams.get('mode'), 'auto');
        assert.equal(harness.searchParams.get('runner'), 'safari-macos-18.6');

        const recorded = fake.log.find((entry) => entry.path.endsWith('/execute/async') && entry.body.script.includes('__matrix.done'));
        assert.ok(recorded);
        const timeouts = fake.log.filter((entry) => entry.path.endsWith('/timeouts') && entry.body?.script === ROW_TIMEOUT_MS);
        assert.ok(timeouts.length >= 1);

        assert.equal(result.exitCode, 0);
        assert.equal(sink.posts.length, 1);
        const posted = sink.posts[0];
        const written = JSON.parse(await readFile(path.join(work, 'safari-macos-18.6.json'), 'utf8'));

        assert.deepEqual(written, posted);
        assert.equal(posted.runner, 'safari-macos-18.6');
        assert.deepEqual(posted.browser, { name: 'Safari', version: '18.6' });
        assert.deepEqual(posted.os, { name: 'macOS', version: '15.1' });
        assert.equal(posted.device, null);
        assert.equal(posted.started_at, '2026-11-20T00:00:00.000Z');
        assert.match(posted.finished_at, /^\d{4}-\d{2}-\d{2}T/);
        assert.notEqual(posted.finished_at, '2026-11-20T00:00:01.000Z');
        assert.deepEqual(posted.rows.map((row) => row.outcome), ['pass', 'pass', 'pass']);
        assert.deepEqual(posted.rows.map((row) => `${row.item}|${row.rendition}|${row.variant}`), KEYS);
        assert.equal(posted.rows[0].required, true);
        assert.equal(posted.rows[2].required, false);
        assert.equal(fake.log.filter((entry) => entry.path.endsWith('/click')).length, KEYS.length);
        assert.equal(
            fake.log.filter((entry) => JSON.stringify(entry.body || {}).includes('.click(')).length,
            0,
        );
    } finally {
        await fake.close();
        await sink.close();
        await rm(work, { recursive: true, force: true });
    }
});

test('safari CLI against the fake driver posts safari-macos results', { timeout: 15_000 }, async () => {
    const fake = await startFakeWebDriver({
        buttons: KEYS,
        returnedCapabilities: { browserVersion: '18.6', platformName: 'macOS', platformVersion: '15.1' },
    });
    const sink = await startResultsSink();
    const work = await makeWorkDir();

    try {
        const child = await runNode(
            SAFARI_CLI,
            ['--target', 'safari', '--base', sink.url, '--out', work],
            { AUDIO_MATRIX_DRIVER_URL: fake.url, AUDIO_MATRIX_SAFARI_LOCK: path.join(work, 'lock') },
        );

        assert.equal(child.code, 0, child.stderr);
        assert.equal(sink.posts[0].runner, 'safari-macos-18.6');
        assert.deepEqual(fake.page.state.clicks, KEYS);
    } finally {
        await fake.close();
        await sink.close();
        await rm(work, { recursive: true, force: true });
    }
});

test('iOS simulator runner sends useSimulator and the device UDID', { timeout: 15_000 }, async () => {
    const fake = await startFakeWebDriver({
        buttons: KEYS,
        userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        returnedCapabilities: {
            browserVersion: '26.2',
            'safari:platformVersion': '26.2',
            'safari:deviceName': 'iPhone 16',
            'safari:deviceType': 'iPhone',
        },
    });
    const sink = await startResultsSink();
    const work = await makeWorkDir();

    try {
        const result = await runSafari({
            target: 'simulator',
            udid: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
            base: sink.url,
            out: work,
            driverUrl: fake.url,
            lockPath: path.join(work, 'safari.lock'),
        });
        const session = fake.log.find((entry) => entry.method === 'POST' && entry.path === '/session');

        assert.deepEqual(session.body.capabilities.alwaysMatch, {
            browserName: 'safari',
            platformName: 'iOS',
            'safari:useSimulator': true,
            'safari:deviceUDID': 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
        });
        assert.equal(result.exitCode, 0);
        assert.equal(sink.posts[0].runner, 'ios-26.2-iphone-16');
        assert.equal(sink.posts[0].device, 'iPhone 16 (sim)');
        assert.deepEqual(sink.posts[0].os, { name: 'iOS', version: '26.2' });
        assert.deepEqual(sink.posts[0].browser, { name: 'Safari', version: '26.2' });
        assert.equal(new URL(fake.page && fake.log.filter((entry) => entry.path.endsWith('/url')).at(-1).body.url).searchParams.get('runner'), 'ios-26.2-iphone-16');
        const written = await readFile(path.join(work, 'ios-26.2-iphone-16.json'), 'utf8');
        assert.equal(JSON.parse(written).runner, 'ios-26.2-iphone-16');
    } finally {
        await fake.close();
        await sink.close();
        await rm(work, { recursive: true, force: true });
    }
});

test('simulator without a UDID is refused before a session', { timeout: 15_000 }, async () => {
    const work = await makeWorkDir();

    try {
        await assert.rejects(
            () => runSafari({
                target: 'simulator',
                base: 'http://127.0.0.1:9',
                out: work,
                driverUrl: 'http://127.0.0.1:9',
                lockPath: path.join(work, 'lock'),
            }),
            /safari:deviceUDID/,
        );
    } finally {
        await rm(work, { recursive: true, force: true });
    }
});

test('a row that exceeds the script cap is infra and the click order is kept', { timeout: 15_000 }, async () => {
    const keys = [
        'voice-memo|playback|live',
        'voice-memo-60s|playback|live',
        'upload|original|as-stored',
    ];
    const fake = await startFakeWebDriver({
        buttons: keys,
        hangKeys: ['voice-memo-60s|playback|live'],
        returnedCapabilities: { browserVersion: '18.6', platformName: 'macOS', platformVersion: '15.1' },
    });
    const sink = await startResultsSink();
    const work = await makeWorkDir();

    try {
        const result = await runSafari({
            target: 'safari',
            base: sink.url,
            out: work,
            driverUrl: fake.url,
            lockPath: path.join(work, 'lock'),
            rowTimeoutMs: 400,
        });

        assert.equal(result.exitCode, 1);
        assert.deepEqual(fake.page.state.clicks, keys);
        assert.deepEqual(
            fake.log.filter((entry) => entry.path.endsWith('/execute/async')).map(() => true).length > 0,
            true,
        );
        const doneTimeouts = fake.log
            .filter((entry) => entry.path.endsWith('/timeouts') && entry.body?.script != null)
            .map((entry) => entry.body.script);
        assert.ok(doneTimeouts.includes(400));
        assert.equal(sink.posts.length, 1);
        const rows = sink.posts[0].rows;
        assert.deepEqual(rows.map((row) => row.outcome), ['pass', 'infra', 'pass']);
        assert.equal(rows[1].required, true);
        assert.match(rows[1].error.message, /Timed out after 400 ms/);
        assert.equal(rows[0].outcome, 'pass');
        assert.equal(rows[2].required, false);
    } finally {
        await fake.close();
        await sink.close();
        await rm(work, { recursive: true, force: true });
    }
});

test('a second Safari run is refused while the first session holds the lock', { timeout: 15_000 }, async () => {
    const fake = await startFakeWebDriver({
        buttons: ['voice-memo|playback|live'],
        hangKeys: ['voice-memo|playback|live'],
        returnedCapabilities: { browserVersion: '18.6', platformName: 'macOS', platformVersion: '15.1' },
    });
    const sink = await startResultsSink();
    const work = await makeWorkDir();
    const lockPath = path.join(work, 'one.lock');

    try {
        const first = runSafari({
            target: 'safari',
            base: sink.url,
            out: work,
            driverUrl: fake.url,
            lockPath,
            rowTimeoutMs: 800,
        });

        const started = Date.now();

        while (!await readFile(lockPath, 'utf8').catch(() => '')) {
            if (Date.now() - started > 5_000) {
                throw new Error('the first Safari run did not take the lock');
            }

            await new Promise((resolve) => setTimeout(resolve, 20));
        }

        await assert.rejects(
            () => runSafari({
                target: 'safari',
                base: sink.url,
                out: path.join(work, 'other'),
                driverUrl: fake.url,
                lockPath,
                rowTimeoutMs: 800,
            }),
            /only one WebDriver session/,
        );

        const result = await first;
        assert.equal(result.exitCode, 1);
        assert.equal(fake.log.filter((entry) => entry.method === 'POST' && entry.path === '/session').length, 1);
        assert.equal(sink.posts.length, 1);
    } finally {
        await fake.close();
        await sink.close();
        await rm(work, { recursive: true, force: true });
    }
});

test('a stale Safari lock left by a dead process is replaced', { timeout: 15_000 }, async () => {
    const fake = await startFakeWebDriver({
        buttons: ['voice-memo|playback|live'],
        returnedCapabilities: { browserVersion: '18.6', platformName: 'macOS', platformVersion: '15.1' },
    });
    const sink = await startResultsSink();
    const work = await makeWorkDir();
    const lockPath = path.join(work, 'stale.lock');
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    await once(child, 'exit');

    try {
        await writeFile(lockPath, `${child.pid}\n`);
        const result = await runSafari({
            target: 'safari',
            base: sink.url,
            out: work,
            driverUrl: fake.url,
            lockPath,
        });

        assert.equal(result.exitCode, 0);
        assert.equal(sink.posts.length, 1);
    } finally {
        await fake.close();
        await sink.close();
        await rm(work, { recursive: true, force: true });
    }
});

test('user agent fills a Safari version the capabilities omit', { timeout: 15_000 }, async () => {
    const fake = await startFakeWebDriver({
        buttons: ['voice-memo|playback|live'],
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Safari/605.1.15',
        returnedCapabilities: {},
    });
    const sink = await startResultsSink();
    const work = await makeWorkDir();

    try {
        const result = await runSafari({
            target: 'safari',
            base: sink.url,
            out: work,
            driverUrl: fake.url,
            lockPath: path.join(work, 'lock'),
        });
        const navigations = fake.log.filter((entry) => entry.path.endsWith('/url')).map((entry) => entry.body.url);

        assert.equal(navigations[0], 'about:blank');
        assert.equal(new URL(navigations.at(-1)).searchParams.get('runner'), 'safari-macos-19.1');
        assert.equal(result.results.browser.version, '19.1');
        assert.equal(result.results.os.version, '14.6');
    } finally {
        await fake.close();
        await sink.close();
        await rm(work, { recursive: true, force: true });
    }
});

test('android chrome runner: package caps, emulator URL, host results', { timeout: 15_000 }, async () => {
    const fake = await startFakeWebDriver({
        buttons: KEYS,
        userAgent: 'Mozilla/5.0 (Linux; Android 14; sdk_gphone64_x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.135 Mobile Safari/537.36',
        returnedCapabilities: {
            browserVersion: '131.0.6778.135',
            platformName: 'android',
            platformVersion: '14',
        },
    });
    const sink = await startResultsSink();
    const work = await makeWorkDir();

    try {
        const result = await runAndroid({
            base: sink.url,
            out: work,
            driverUrl: fake.url,
        });
        const session = fake.log.find((entry) => entry.method === 'POST' && entry.path === '/session');

        assert.deepEqual(session.body.capabilities.alwaysMatch, {
            browserName: 'chrome',
            'goog:chromeOptions': {
                androidPackage: 'com.android.chrome',
                args: [...ANDROID_CHROME_ARGS],
            },
        });
        assert.deepEqual(ANDROID_CHROME_ARGS, ['--disable-fre', '--no-default-browser-check', '--no-first-run']);

        const harness = new URL(fake.log.filter((entry) => entry.path.endsWith('/url')).at(-1).body.url);
        assert.equal(harness.hostname, '10.0.2.2');
        assert.equal(harness.port, new URL(sink.url).port);
        assert.equal(harness.searchParams.get('mode'), 'auto');
        assert.equal(harness.searchParams.get('runner'), 'android-chrome-131.0.6778.135');
        assert.equal(result.exitCode, 0);
        assert.equal(sink.posts.length, 1);
        assert.equal(sink.posts[0].runner, 'android-chrome-131.0.6778.135');
        assert.deepEqual(sink.posts[0].browser, { name: 'Chrome', version: '131.0.6778.135' });
        assert.deepEqual(sink.posts[0].os, { name: 'Android', version: '14' });
        assert.equal(sink.posts[0].device, 'sdk_gphone64_x86_64');
        assert.deepEqual(fake.page.state.clicks, KEYS);
        assert.deepEqual(sink.posts[0].rows.map((row) => row.outcome), ['pass', 'pass', 'pass']);

        const written = JSON.parse(await readFile(path.join(work, 'android-chrome-131.0.6778.135.json'), 'utf8'));
        assert.deepEqual(written, sink.posts[0]);
        assert.equal(fake.log.filter((entry) => entry.method === 'DELETE').length, 1);
    } finally {
        await fake.close();
        await sink.close();
        await rm(work, { recursive: true, force: true });
    }
});

test('android serial is sent as androidDeviceSerial', { timeout: 15_000 }, async () => {
    const fake = await startFakeWebDriver({
        buttons: ['voice-memo|playback|live'],
        returnedCapabilities: { browserVersion: '131.0.6778.135', platformVersion: '14' },
    });
    const sink = await startResultsSink();
    const work = await makeWorkDir();

    try {
        await runAndroid({
            base: sink.url,
            out: work,
            serial: 'emulator-5554',
            driverUrl: fake.url,
        });
        const caps = fake.log.find((entry) => entry.path === '/session').body.capabilities.alwaysMatch;

        assert.equal(caps['goog:chromeOptions'].androidDeviceSerial, 'emulator-5554');
        assert.equal(caps['goog:chromeOptions'].androidPackage, 'com.android.chrome');
    } finally {
        await fake.close();
        await sink.close();
        await rm(work, { recursive: true, force: true });
    }
});

test('android CLI posts to the host and opens 10.0.2.2', { timeout: 15_000 }, async () => {
    const fake = await startFakeWebDriver({
        buttons: KEYS,
        userAgent: 'Mozilla/5.0 (Linux; Android 14; sdk_gphone64_x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.135 Mobile Safari/537.36',
        returnedCapabilities: { browserVersion: '131.0.6778.135', platformVersion: '14' },
    });
    const sink = await startResultsSink();
    const work = await makeWorkDir();

    try {
        const child = await runNode(
            ANDROID_CLI,
            ['--base', sink.url, '--out', work],
            { AUDIO_MATRIX_DRIVER_URL: fake.url },
        );

        assert.equal(child.code, 0, child.stderr);
        const harness = new URL(fake.log.filter((entry) => entry.path.endsWith('/url')).at(-1).body.url);
        assert.equal(harness.hostname, '10.0.2.2');
        assert.equal(sink.posts.length, 1);
        assert.equal(sink.posts[0].runner, 'android-chrome-131.0.6778.135');
    } finally {
        await fake.close();
        await sink.close();
        await rm(work, { recursive: true, force: true });
    }
});

test('android timeout becomes infra', { timeout: 15_000 }, async () => {
    const fake = await startFakeWebDriver({
        buttons: ['voice-memo|playback|live', 'upload|playback|no-cache'],
        hangKeys: ['upload|playback|no-cache'],
        returnedCapabilities: { browserVersion: '120.0.0.0', platformVersion: '14' },
    });
    const sink = await startResultsSink();
    const work = await makeWorkDir();

    try {
        const result = await runAndroid({
            base: sink.url,
            out: work,
            driverUrl: fake.url,
            rowTimeoutMs: 300,
        });

        assert.equal(result.exitCode, 0);
        assert.deepEqual(sink.posts[0].rows.map((row) => [row.outcome, row.required]), [
            ['pass', true],
            ['infra', false],
        ]);
        assert.match(sink.posts[0].rows[1].error.message, /Timed out after 300 ms/);
    } finally {
        await fake.close();
        await sink.close();
        await rm(work, { recursive: true, force: true });
    }
});

test('pm path with no package is infra and names Chrome', async () => {
    await assert.rejects(
        () => assertChromeInstalled({
            serial: 'emulator-5554',
            execFile: async (command, args) => {
                assert.equal(command, 'adb');
                assert.deepEqual(args.slice(0, 2), ['-s', 'emulator-5554']);
                assert.deepEqual(args.slice(2), ['shell', 'pm', 'path', 'com.android.chrome']);

                return { stdout: '' };
            },
        }),
        /com\.android\.chrome is not installed/,
    );
});

test('Chrome for Testing picker matches the major and refuses other hosts', () => {
    const catalog = {
        milestones: {
            131: {
                version: '131.0.6778.204',
                downloads: {
                    chromedriver: [
                        { platform: 'linux64', url: 'https://storage.googleapis.com/chrome-for-testing-public/131.0.6778.204/linux64/chromedriver-linux64.zip' },
                        { platform: 'mac-arm64', url: 'https://storage.googleapis.com/chrome-for-testing-public/131.0.6778.204/mac-arm64/chromedriver-mac-arm64.zip' },
                    ],
                },
            },
        },
    };
    const picked = pickChromedriverDownload(catalog, '131.0.6778.135', 'linux64');

    assert.equal(picked.version, '131.0.6778.204');
    assert.equal(picked.major, '131');
    assert.match(picked.url, /chromedriver-linux64\.zip$/);

    const evil = structuredClone(catalog);
    evil.milestones[131].downloads.chromedriver[0].url = 'https://example.com/chromedriver.zip';
    assert.throws(() => pickChromedriverDownload(evil, '131.0.6778.135', 'linux64'), /storage\.googleapis\.com/);
    assert.throws(() => pickChromedriverDownload(catalog, '99.0.0.0', 'linux64'), /no milestone 99/);
});

test('zip extractor returns the chromedriver entry and checks the checksum', () => {
    const payload = Buffer.from('#!/bin/sh\necho chromedriver\n');
    const zip = makeZip([
        { name: 'chromedriver-linux64/LICENSE.chromedriver', data: Buffer.from('licence'), method: 8 },
        { name: 'chromedriver-linux64/chromedriver', data: payload, method: 8 },
    ]);
    const extracted = extractZipEntry(zip, (name) => /(^|\/)chromedriver(\.exe)?$/.test(name));

    assert.ok(extracted);
    assert.equal(extracted.toString('utf8'), payload.toString('utf8'));

    const stored = makeZip([
        { name: 'chromedriver-mac-arm64/chromedriver', data: payload, method: 0 },
    ]);
    assert.equal(
        extractZipEntry(stored, (name) => /(^|\/)chromedriver(\.exe)?$/.test(name)).toString('utf8'),
        payload.toString('utf8'),
    );
});

test('resolveChromedriver downloads the milestone zip when nothing is on PATH', { timeout: 15_000 }, async () => {
    const payload = Buffer.from('not-a-real-chromedriver');
    const zip = makeZip([
        { name: 'chromedriver-linux64/chromedriver', data: payload, method: 8 },
    ]);
    const work = await makeWorkDir();
    const calls = [];
    const catalog = {
        ok: true,
        status: 200,
        json: async () => ({
            milestones: {
                131: {
                    version: '131.0.6778.204',
                    downloads: {
                        chromedriver: [
                            {
                                platform: 'linux64',
                                url: 'https://storage.googleapis.com/chrome-for-testing-public/131.0.6778.204/linux64/chromedriver-linux64.zip',
                            },
                        ],
                    },
                },
            },
        }),
    };
    const fetchImpl = async (url) => {
        calls.push(String(url));

        if (String(url) === CFT_MILESTONES_URL) {
            return catalog;
        }

        return {
            ok: true,
            status: 200,
            arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength),
        };
    };

    try {
        const resolved = await resolveChromedriver({
            chromeVersion: '131.0.6778.135',
            platform: 'linux64',
            cacheDir: work,
            env: {},
            findOnPath: async () => null,
            fetchImpl,
        });

        assert.equal(resolved.source, 'chrome-for-testing');
        assert.equal(resolved.version, '131.0.6778.204');
        assert.equal(await readFile(resolved.path, 'utf8'), payload.toString('utf8'));
        assert.equal(calls[0], CFT_MILESTONES_URL);
        assert.match(calls[1], /^https:\/\/storage\.googleapis\.com\//);

        // The milestone JSON is small and names the patch we cache under.
        // A second resolve may fetch it again, but must not download the zip twice.
        const before = calls.length;
        const again = await resolveChromedriver({
            chromeVersion: '131.0.6778.135',
            platform: 'linux64',
            cacheDir: work,
            env: {},
            findOnPath: async () => null,
            fetchImpl,
        });

        assert.equal(again.path, resolved.path);
        assert.deepEqual(calls.slice(before), [CFT_MILESTONES_URL]);
    } finally {
        await rm(work, { recursive: true, force: true });
    }
});

test('resolveChromedriver prefers a matching PATH driver and does not download', async () => {
    let fetched = false;
    const resolved = await resolveChromedriver({
        env: {},
        chromeVersion: '131.0.6778.81',
        driverVersion: () => '131',
        findOnPath: async () => '/opt/chromedriver',
        fetchImpl: async () => {
            fetched = true;

            return { ok: false, status: 500 };
        },
    });

    assert.equal(resolved.path, '/opt/chromedriver');
    assert.equal(resolved.source, 'PATH');
    assert.equal(fetched, false);
});

test('resolveChromedriver ignores a PATH driver for another Chrome and uses the legacy store for 114 and older', async () => {
    const urls = [];
    await assert.rejects(resolveChromedriver({
        env: {},
        chromeVersion: '113.0.5672.136',
        driverVersion: () => '157',
        findOnPath: async () => '/opt/chromedriver',
        platform: 'linux64',
        fetchImpl: async (url) => {
            urls.push(String(url));
            if (String(url).endsWith('/LATEST_RELEASE_113')) return { ok: true, text: async () => '113.0.5672.63\n' };
            return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
        },
        cacheDir: (await import('node:os')).tmpdir() + '/am-legacy-test-' + process.pid,
    }));
    assert.equal(urls[0], 'https://chromedriver.storage.googleapis.com/LATEST_RELEASE_113');
    assert.equal(urls[1], 'https://chromedriver.storage.googleapis.com/113.0.5672.63/chromedriver_linux64.zip');
});
