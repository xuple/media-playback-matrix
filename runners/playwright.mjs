// Owner: audio-matrix R1. 2026-11-20.
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const BROWSERS = ['chrome', 'msedge', 'firefox', 'webkit', 'chromium'];
export const platformName = (platform = process.platform) =>
    ({ darwin: 'macos', win32: 'windows', linux: 'linux' })[platform] ?? platform;
const rowKey = row => `${row.item}|${row.rendition}|${row.variant}`;
const message = error => String(error?.message ?? error);

function deadline(promise, ms, detail) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(detail)), ms); }),
    ]).finally(() => clearTimeout(timer));
}

export function fixtureRows(manifest) {
    return manifest.items.flatMap(item => [
        ['playback', 'live'], ['original', 'live'], ['original', 'as-stored'],
    ].filter(([rendition]) => item[rendition]?.file || rendition === 'playback')
        .map(([rendition, variant]) => ({
            item: item.id, rendition, variant,
            required: rendition === 'playback' && variant === 'live',
            outcome: 'missing', stages: {}, requests: [],
        })));
}

export async function runBrowser({ browserName, playwright, manifest, base, out = 'out',
    fetchFn = fetch, platform = process.platform, rowTimeoutMs = 40_000, readyTimeoutMs = 120_000 }) {
    if (!BROWSERS.includes(browserName)) throw new Error(`Unknown browser: ${browserName}`);
    const runner = `${platformName(platform)}-${browserName}`;
    const started = new Date().toISOString();
    const fallback = fixtureRows(manifest);
    const overrides = new Map();
    let browser;
    let snapshot;
    let version = 'unavailable';
    let failure;
    const infra = (row, error) => ({ ...row, outcome: 'infra', error: { message: message(error) } });
    try {
        if (!playwright) throw new Error('Playwright 1.56.1 is unavailable; install the pinned runners/package.json dependencies');
        const type = ['chrome', 'msedge'].includes(browserName) ? 'chromium' : browserName;
        browser = await playwright[type].launch(['chrome', 'msedge'].includes(browserName)
            ? { channel: browserName } : {});
        version = browser.version();
        const context = await browser.newContext();
        const page = await context.newPage();
        // H observed that even read-only evaluation grants activation in Chromium/WebKit.
        // Subscribe before navigation and execute no page script until the muted pass finishes.
        const ready = page.waitForEvent('console', {
            predicate: event => event.text() === 'audio-matrix:ready', timeout: readyTimeoutMs,
        });
        ready.catch(() => {}); // Navigation can fail before the console wait rejects.
        const url = new URL(base);
        url.searchParams.set('mode', 'auto');
        url.searchParams.set('runner', runner);
        url.searchParams.set('variants', 'live,as-stored');
        await page.goto(url.href);
        await ready;
        snapshot = await page.evaluate(() => window.__matrix.results());
        const keys = await page.locator('button[data-play]').evaluateAll(
            buttons => buttons.map(button => button.getAttribute('data-play')),
        );
        for (const key of keys) {
            try {
                // The host deadline covers both the actual click and the done promise.
                const completed = await deadline((async () => {
                    await page.locator(`button[data-play=${JSON.stringify(key)}]`).click({ timeout: rowTimeoutMs });
                    const row = await page.evaluate(key => window.__matrix.done(key), key);
                    if (!row || rowKey(row) !== key) throw new Error(`Invalid done result for ${key}`);
                    return row;
                })(), rowTimeoutMs, `done(${key}) exceeded ${rowTimeoutMs} ms`);
                overrides.set(key, completed);
            } catch (error) {
                const row = snapshot.rows.find(row => rowKey(row) === key) ?? fallback.find(row => rowKey(row) === key);
                if (!row) throw new Error(`Unknown row button: ${key}`);
                overrides.set(key, infra(row, error));
            }
        }
        snapshot = await page.evaluate(() => window.__matrix.results());
    } catch (error) {
        failure = message(error);
    } finally {
        if (browser) {
            try { await browser.close(); } catch (error) { failure ??= message(error); }
        }
    }
    const rows = new Map((snapshot?.rows ?? fallback).map(row => [rowKey(row), row]));
    for (const row of fallback) {
        if (!rows.has(rowKey(row))) rows.set(rowKey(row), row);
    }
    for (const [key, row] of rows) {
        const completed = overrides.get(key);
        rows.set(key, completed ?? (failure ? infra(row, failure) : row));
    }
    const result = {
        ...(snapshot ?? { device: null, server_commit: null,
            recipe_sha256: manifest.recipe_sha256 ?? null }),
        runner,
        browser: { name: browserName === 'webkit' ? 'WebKit (not Safari)' : browserName, version },
        os: { name: platformName(platform), version: os.release() },
        runtime: { node: process.version, playwright: '1.56.1' },
        started_at: snapshot?.started_at ?? started,
        finished_at: new Date().toISOString(), rows: [...rows.values()],
        ...(failure ? { runner_error: failure } : {}),
    };
    await mkdir(out, { recursive: true });
    const filename = path.join(out, `${runner}.json`);
    await writeFile(filename, `${JSON.stringify(result, null, 2)}\n`);
    let posted = true;
    try {
        const response = await fetchFn(new URL('/results', base), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(result), signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`POST /results returned ${response.status}`);
    } catch (error) {
        posted = false;
        result.runner_error = [result.runner_error, message(error)].filter(Boolean).join('; ');
        await writeFile(filename, `${JSON.stringify(result, null, 2)}\n`);
    }
    return { result, exitCode: failure || !posted || result.rows.some(row => row.required && row.outcome !== 'pass') ? 1 : 0 };
}

export async function main(argv = process.argv.slice(2)) {
    const { values } = parseArgs({ args: argv, options: {
        browsers: { type: 'string', default: BROWSERS.join(',') },
        base: { type: 'string', default: 'http://127.0.0.1:8765' },
        out: { type: 'string', default: 'out' },
    } });
    const browsers = values.browsers.split(',');
    if (!browsers.length || browsers.some(name => !BROWSERS.includes(name)) || new Set(browsers).size !== browsers.length) {
        throw new Error('Use a unique comma-separated list of chrome,msedge,firefox,webkit,chromium');
    }
    const base = new URL(values.base);
    if (!['http:', 'https:'].includes(base.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
        throw new Error('--base must be a local HTTP server');
    }
    // Local fixtures still provide explicit infra rows when the server or installation is absent.
    let manifest = JSON.parse(await readFile(new URL('../fixtures/manifest.json', import.meta.url), 'utf8'));
    try {
        const response = await fetch(new URL('manifest.json', base.href.endsWith('/') ? base : `${base}/`), { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`Manifest returned ${response.status}`);
        manifest = await response.json();
    } catch (error) { process.stderr.write(`${message(error)}; using bundled manifest\n`); }
    let playwright;
    try { playwright = await import('playwright'); }
    catch (error) { process.stderr.write(`${message(error)}\n`); }
    let exitCode = 0;
    for (const browserName of browsers) {
        const run = await runBrowser({ browserName, playwright, manifest, base, out: values.out });
        process.stderr.write(`${run.result.runner}: ${run.result.rows.filter(row => row.outcome === 'pass').length}/${run.result.rows.length} passed\n`);
        exitCode ||= run.exitCode;
    }
    return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().then(code => { process.exitCode = code; }).catch(error => {
        process.stderr.write(`${message(error)}\n`); process.exitCode = 1;
    });
}
