// Shared click loop for the Safari and Android Chrome runners.
// Date: 2026-11-20. Owner: audio-matrix R2.
// One real WebDriver click per Play button, then window.__matrix.done(key).
// A driver-side wait past the cap is infra (a runner failure), not fail:stall —
// stall is reserved for the harness's own media deadlines.

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { WebDriver, WebDriverError } from './webdriver.mjs';

export const ROW_TIMEOUT_MS = 40_000;

const READY_SCRIPT = `
const done = arguments[arguments.length - 1];
try {
    const matrix = window.__matrix;
    if (!matrix || matrix.ready == null) {
        done({ ok: false, message: 'window.__matrix.ready is missing' });
    } else {
        Promise.resolve(matrix.ready).then(
            function () { done({ ok: true }); },
            function (err) { done({ ok: false, message: String(err && err.message || err) }); },
        );
    }
} catch (err) {
    done({ ok: false, message: String(err && err.message || err) });
}
`;

const LIST_SCRIPT = `
var nodes = document.querySelectorAll('button[data-play]');
var keys = [];
for (var i = 0; i < nodes.length; i++) keys.push(nodes[i].getAttribute('data-play'));
return keys;
`;

const DONE_SCRIPT = `
const key = arguments[0];
const done = arguments[arguments.length - 1];
try {
    const matrix = window.__matrix;
    if (!matrix || typeof matrix.done !== 'function') {
        done({ __infra: true, message: 'window.__matrix.done is missing' });
    } else {
        Promise.resolve(matrix.done(key)).then(
            function (row) { done({ __infra: false, row: row || null }); },
            function (err) { done({ __infra: true, message: String(err && err.message || err) }); },
        );
    }
} catch (err) {
    done({ __infra: true, message: String(err && err.message || err) });
}
`;

const RENDITIONS = new Set(['playback', 'original']);
const VARIANTS = new Set(['live', 'no-cache', 'as-stored']);

function defaultLog(message) {
    process.stderr.write(`${message}\n`);
}

export function slug(value) {
    return String(value)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9.]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

export function assertHttpBase(base) {
    let url;

    try {
        url = new URL(base);
    } catch {
        throw new Error(`Base URL is not valid: ${base}`);
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`Base URL must be http or https: ${base}`);
    }

    return url;
}

export function withHostname(base, hostname) {
    const url = assertHttpBase(base);
    url.hostname = hostname;

    return url.origin;
}

export function harnessUrl(base, label) {
    const url = new URL('/', assertHttpBase(base).origin);
    url.searchParams.set('mode', 'auto');
    url.searchParams.set('runner', label);

    return url.toString();
}

/** File-name safe label. The results file is out/<label>.json, so the label cannot carry a path. */
export function safeLabel(label) {
    const cleaned = slug(label);

    if (!cleaned || !/^[a-z0-9][a-z0-9.-]*$/.test(cleaned)) {
        throw new Error(`Runner label "${label}" cannot be used as a file name.`);
    }

    return cleaned;
}

export function parseUserAgent(userAgent) {
    const text = String(userAgent || '');
    const take = (pattern) => {
        const match = pattern.exec(text);

        return match ? match[1] : '';
    };
    const underscores = (value) => value.replace(/_/g, '.');
    let device = '';

    if (/iPad/.test(text)) {
        device = 'iPad';
    } else if (/iPhone/.test(text)) {
        device = 'iPhone';
    } else {
        const model = take(/Android [\d.]+;\s*([^;)]+)/);

        if (model) {
            device = model.replace(/\s+Build\/.*/, '').trim();
        }
    }

    return {
        safariVersion: take(/Version\/([\d.]+)/),
        chromeVersion: take(/Chrome\/([\d.]+)/),
        macVersion: underscores(take(/Mac OS X ([\d_]+)/)),
        iosVersion: underscores(take(/CPU (?:iPhone |iPad )?OS ([\d_]+)/)),
        androidVersion: take(/Android ([\d.]+)/),
        device,
    };
}

/**
 * Desktop label safari-macos-<ver>. Simulator label ios-<runtime>-<device>.
 * Versions come from the new-session capabilities first (safaridriver returns
 * browserVersion, safari:platformVersion, safari:deviceName) and from the user agent
 * only when a capability is absent.
 */
export function identifySafari({ target, capabilities = {}, userAgent = '' }) {
    const ua = parseUserAgent(userAgent);
    const platform = String(capabilities.platformName || '');
    const simulator = target === 'simulator'
        || capabilities['safari:useSimulator'] === true
        || platform.toLowerCase() === 'ios';

    if (simulator) {
        const runtime = capabilities['safari:platformVersion'] || ua.iosVersion || 'unknown';
        const deviceName = capabilities['safari:deviceName'] || ua.device || 'device';
        const browserVersion = capabilities.browserVersion || ua.safariVersion || runtime;

        return {
            label: safeLabel(`ios-${slug(runtime)}-${slug(deviceName)}`),
            browser: { name: 'Safari', version: String(browserVersion) },
            os: { name: 'iOS', version: String(runtime) },
            device: capabilities['safari:useSimulator'] || target === 'simulator' ? `${deviceName} (sim)` : deviceName,
        };
    }

    const version = capabilities.browserVersion || ua.safariVersion || 'unknown';
    const osVersion = capabilities.platformVersion || capabilities['safari:platformVersion'] || ua.macVersion || '';

    return {
        label: safeLabel(`safari-macos-${slug(version)}`),
        browser: { name: 'Safari', version: String(version) },
        os: { name: 'macOS', version: String(osVersion) },
        device: null,
    };
}

/** Android label is android-chrome-<version>, mirroring the Safari labels. */
export function identifyAndroid({ capabilities = {}, userAgent = '' }) {
    const ua = parseUserAgent(userAgent);
    const version = capabilities.browserVersion || ua.chromeVersion || 'unknown';
    const osVersion = capabilities.platformVersion || ua.androidVersion || '';

    return {
        label: safeLabel(`android-chrome-${slug(version)}`),
        browser: { name: 'Chrome', version: String(version) },
        os: { name: 'Android', version: String(osVersion) },
        device: ua.device || null,
    };
}

export function safariCapabilities(target, udid) {
    if (target === 'safari') {
        return { browserName: 'safari' };
    }

    if (target === 'simulator') {
        if (!udid) {
            throw new Error('The simulator target needs --udid <udid> (safari:deviceUDID).');
        }

        return {
            browserName: 'safari',
            platformName: 'iOS',
            'safari:useSimulator': true,
            'safari:deviceUDID': udid,
        };
    }

    throw new Error('Missing or unknown --target. Use safari or simulator.');
}

export const ANDROID_CHROME_ARGS = ['--disable-fre', '--no-default-browser-check', '--no-first-run'];

export function androidCapabilities(serial) {
    const chromeOptions = {
        androidPackage: 'com.android.chrome',
        args: [...ANDROID_CHROME_ARGS],
    };

    if (serial) {
        chromeOptions.androidDeviceSerial = serial;
    }

    return {
        browserName: 'chrome',
        'goog:chromeOptions': chromeOptions,
    };
}

function cssAttr(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function parseKey(key) {
    const parts = String(key).split('|');

    if (parts.length !== 3 || parts.some((part) => part === '')) {
        throw new Error(`Play button key "${key}" is not id|rendition|variant.`);
    }

    const [item, rendition, variant] = parts;

    if (!RENDITIONS.has(rendition) || !VARIANTS.has(variant)) {
        throw new Error(`Play button key "${key}" has an unknown rendition or variant.`);
    }

    return { item, rendition, variant };
}

function syntheticRow(key, outcome, message) {
    const { item, rendition, variant } = parseKey(key);
    const detail = message;

    return {
        item,
        rendition,
        variant,
        required: rendition === 'playback' && variant === 'live',
        outcome,
        can_play_type: '',
        stages: {
            load: { ok: false, ms: 0, detail },
            play: { ok: false, ms: 0, detail },
            seek: null,
            replay: null,
            muted_autoplay: null,
        },
        duration: null,
        error: { code: outcome === 'infra' ? 'timeout' : outcome, message },
        requests: [],
    };
}

function rowKey(row) {
    return `${row.item}|${row.rendition}|${row.variant}`;
}

export function mergeRows(keys, harnessRows, infra, fromDone) {
    const byKey = new Map();

    for (const row of harnessRows || []) {
        if (row && row.item && row.rendition && row.variant) {
            byKey.set(rowKey(row), row);
        }
    }

    return keys.map((key) => {
        const message = infra.get(key);
        const existing = byKey.get(key) || fromDone.get(key);

        if (message) {
            if (existing) {
                return {
                    ...existing,
                    outcome: 'infra',
                    error: existing.error || { code: 'timeout', message },
                };
            }

            return syntheticRow(key, 'infra', message);
        }

        if (existing) {
            return existing;
        }

        return syntheticRow(key, 'missing', 'Row missing from window.__matrix.results()');
    });
}

function needsUserAgent(identity) {
    return identity.browser.version === 'unknown' || identity.label.includes('unknown');
}

function refineIdentity(current, next) {
    return {
        label: current.label,
        browser: current.browser.version === 'unknown' ? next.browser : current.browser,
        os: current.os.version ? current.os : { ...next.os, name: current.os.name || next.os.name },
        device: current.device ?? (next.device || null),
    };
}

/**
 * Opens the harness, clicks every Play button in DOM order, and posts the results.
 * navigateBase is what the browser loads. resultsBase is where the host posts /results
 * (the Android emulator cannot use that loopback address).
 */
export async function driveMatrix({
    webdriverUrl,
    capabilities,
    navigateBase,
    resultsBase,
    outDir,
    identify,
    rowTimeoutMs = ROW_TIMEOUT_MS,
    readyTimeoutMs = ROW_TIMEOUT_MS,
    log = defaultLog,
}) {
    const startedAt = new Date().toISOString();
    const wd = new WebDriver(webdriverUrl, { commandTimeoutMs: Math.max(rowTimeoutMs, readyTimeoutMs) + 5_000 });
    let sessionOpen = false;

    try {
        const session = await wd.newSession(capabilities);
        sessionOpen = true;
        const caps = session.capabilities || {};
        let userAgent = '';
        let identity = identify({ capabilities: caps, userAgent });

        // The label is part of the harness URL, so it has to be known before navigation.
        // Capabilities usually carry the version; otherwise read the user agent on about:blank.
        if (needsUserAgent(identity)) {
            await wd.navigate('about:blank');
            userAgent = String(await wd.executeScript('return navigator.userAgent') || '');
            identity = identify({ capabilities: caps, userAgent });
        }

        await wd.setTimeouts({ pageLoad: readyTimeoutMs, implicit: 0 });
        await wd.navigate(harnessUrl(navigateBase, identity.label));

        try {
            userAgent = String(await wd.executeScript('return navigator.userAgent') || userAgent);
            identity = refineIdentity(identity, identify({ capabilities: caps, userAgent }));
        } catch (error) {
            log(`User agent was not readable (${error.message}). Versions fall back to capabilities.`);
        }

        const ready = await wd.executeAsyncScript(READY_SCRIPT, [], { timeoutMs: readyTimeoutMs });

        if (!ready || ready.ok !== true) {
            throw new Error(`The harness did not become ready: ${ready?.message || 'window.__matrix.ready failed'}`);
        }

        const keys = await wd.executeScript(LIST_SCRIPT);

        if (!Array.isArray(keys) || keys.length === 0) {
            throw new Error('No Play buttons were found on the harness page.');
        }

        const infra = new Map();
        const fromDone = new Map();

        for (const key of keys) {
            parseKey(key);

            try {
                // A WebDriver element click, not element.click() in the page. Safari and
                // Chrome on Android treat that as the user gesture the play stage requires.
                const element = await wd.findElement(`button[data-play="${cssAttr(key)}"]`);
                // iOS Safari (simulator) doesn't fire a button from an element click; a W3C touch tap does.
                if (capabilities?.['safari:useSimulator'] === true) {
                    await wd.tap(element);
                } else {
                    await wd.click(element);
                }
                const result = await wd.executeAsyncScript(DONE_SCRIPT, [key], { timeoutMs: rowTimeoutMs });

                if (!result || result.__infra) {
                    const message = result?.message || 'window.__matrix.done failed';
                    infra.set(key, message);
                    log(`infra ${key}: ${message}`);
                } else {
                    if (result.row && result.row.item) {
                        fromDone.set(key, result.row);
                    }

                    log(`done ${key}`);
                }
            } catch (error) {
                const timedOut = error instanceof WebDriverError && (error.code === 'script timeout' || error.code === 'timeout');
                const message = timedOut
                    ? `Timed out after ${rowTimeoutMs} ms waiting for window.__matrix.done`
                    : `WebDriver error: ${error.message}`;
                infra.set(key, message);
                log(`infra ${key}: ${message}`);
            }
        }

        let harness = {};

        try {
            harness = (await wd.executeScript('return window.__matrix.results();')) || {};
        } catch (error) {
            log(`window.__matrix.results() failed: ${error.message}`);
        }

        const results = {
            runner: identity.label,
            browser: identity.browser,
            os: identity.os,
            device: identity.device,
            started_at: typeof harness.started_at === 'string' ? harness.started_at : startedAt,
            finished_at: new Date().toISOString(),
            server_commit: harness.server_commit ?? null,
            recipe_sha256: harness.recipe_sha256 ?? null,
            rows: mergeRows(keys, Array.isArray(harness.rows) ? harness.rows : [], infra, fromDone),
        };
        const outFile = path.join(outDir, `${identity.label}.json`);

        await mkdir(outDir, { recursive: true });
        await writeFile(outFile, `${JSON.stringify(results, null, 2)}\n`);

        const postUrl = new URL('/results', assertHttpBase(resultsBase).origin);
        let response;

        try {
            response = await fetch(postUrl, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(results),
                signal: AbortSignal.timeout(20_000),
            });
        } catch (error) {
            throw new Error(`POST ${postUrl} failed: ${error.message}. Results are in ${outFile}.`);
        }

        if (!response.ok) {
            const text = await response.text().catch(() => '');

            throw new Error(`POST ${postUrl} failed: HTTP ${response.status} ${text}`.trim() + `. Results are in ${outFile}.`);
        }

        const failed = results.rows.some((row) => row.required && row.outcome !== 'pass');

        log(`Wrote ${outFile}`);

        if (failed) {
            log('Required rows did not all pass.');
        }

        return { results, outFile, exitCode: failed ? 1 : 0 };
    } finally {
        if (sessionOpen) {
            await wd.deleteSession().catch((error) => {
                log(`deleteSession failed: ${error.message}`);
            });
        }
    }
}
