// Fake W3C WebDriver for the Safari and Android runners.
// Date: 2026-11-20. Owner: audio-matrix R2.
// Implements the endpoints those runners call, plus an in-memory harness page
// (Play buttons, window.__matrix.ready / done / results). Scripts the runner
// sends are executed against that page so the test drives the real runner code.

import { createServer } from 'node:http';
import vm from 'node:vm';

import { ELEMENT_KEY } from '../../lib/webdriver.mjs';

function send(response, status, value) {
    const body = JSON.stringify({ value: value === undefined ? null : value });

    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
    });
    response.end(body);
}

function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];

        request.on('data', (chunk) => chunks.push(chunk));
        request.on('error', reject);
        request.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');

            if (text.trim() === '') {
                resolve(null);

                return;
            }

            try {
                resolve(JSON.parse(text));
            } catch (error) {
                reject(error);
            }
        });
    });
}

function passRow(key) {
    const [item, rendition, variant] = key.split('|');
    const seek = item.includes('60s');

    return {
        item,
        rendition,
        variant,
        required: rendition === 'playback' && variant === 'live',
        outcome: 'pass',
        can_play_type: 'probably',
        stages: {
            load: { ok: true, ms: 10, detail: 'loadedmetadata' },
            play: { ok: true, ms: 20, detail: 'playing' },
            seek: seek ? { ok: true, ms: 15, detail: 'seeked' } : null,
            replay: seek ? null : { ok: true, ms: 30, detail: 'replayed' },
            muted_autoplay: { ok: true, ms: 5, detail: 'muted' },
        },
        duration: seek ? 60 : 12,
        error: null,
        requests: [{ range: 'bytes=0-1', status: 206, bytes: 2 }],
    };
}

function createPage(options) {
    const buttons = (options.buttons || []).map((key) => ({ key, id: null }));
    const hang = new Set(options.hangKeys || []);
    const delays = options.delays || {};
    const state = {
        clicks: [],
        completed: [],
    };
    const document = {
        querySelectorAll(selector) {
            if (selector === 'button[data-play]') {
                return buttons.map((button) => wrap(button));
            }

            const match = /^button\[data-play="((?:\\.|[^"\\])*)"\]$/.exec(selector);

            if (!match) {
                return [];
            }

            const key = match[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');

            return buttons.filter((button) => button.key === key).map((button) => wrap(button));
        },
    };

    function wrap(button) {
        return {
            getAttribute(name) {
                return name === 'data-play' ? button.key : null;
            },
        };
    }

    const window = {};

    window.__matrix = {
        ready: options.hangReady ? new Promise(() => {}) : Promise.resolve(true),
        done(key) {
            if (hang.has(key)) {
                return new Promise(() => {});
            }

            const delayMs = delays[key] ?? 0;

            return new Promise((resolve) => {
                setTimeout(() => {
                    const row = passRow(key);
                    state.completed.push(row);
                    resolve(row);
                }, delayMs);
            });
        },
        results() {
            return {
                runner: '',
                browser: { name: '', version: '' },
                os: { name: '', version: '' },
                device: null,
                started_at: '2026-11-20T00:00:00.000Z',
                finished_at: '2026-11-20T00:00:01.000Z',
                rows: state.completed.map((row) => structuredClone(row)),
            };
        },
    };

    const navigator = { userAgent: options.userAgent || '' };

    return { buttons, document, window, navigator, state, wrap };
}

function runInPage(script, args, sandbox) {
    const wrapped = `return (function () {\n${script}\n}).apply(this, arguments);`;
    const fn = vm.compileFunction(wrapped, [], { parsingContext: sandbox });

    return fn.apply(undefined, args);
}

function sandboxFor(page) {
    return vm.createContext({
        window: page.window,
        document: page.document,
        navigator: page.navigator,
        Promise,
        setTimeout,
        clearTimeout,
        Array,
        JSON,
        Object,
        String,
        Error,
        Number,
        Math,
        Date,
    });
}

function matchButtons(page, selector) {
    return page.document.querySelectorAll(selector).map((wrapped) => {
        const key = wrapped.getAttribute('data-play');

        return page.buttons.find((button) => button.key === key);
    }).filter(Boolean);
}

function elementReference(button, sequence) {
    if (!button.id) {
        sequence.value += 1;
        button.id = `el-${sequence.value}`;
    }

    return { [ELEMENT_KEY]: button.id };
}

/**
 * @param {{
 *   buttons?: string[],
 *   hangKeys?: string[],
 *   delays?: Record<string, number>,
 *   hangReady?: boolean,
 *   userAgent?: string,
 *   returnedCapabilities?: object,
 *   failSession?: { error: string, message: string } | null,
 * }} [options]
 */
export async function startFakeWebDriver(options = {}) {
    const page = createPage(options);
    const sessions = new Map();
    const log = [];
    const timers = new Set();
    const sequence = { value: 0 };
    let sessionCounter = 0;

    const server = createServer((request, response) => {
        handle(request, response).catch((error) => {
            if (!response.headersSent) {
                send(response, 500, { error: 'unknown error', message: error.message, stacktrace: '' });
            }
        });
    });

    async function handle(request, response) {
        const url = new URL(request.url || '/', 'http://127.0.0.1');
        let body = null;

        try {
            body = await readBody(request);
        } catch {
            send(response, 400, { error: 'invalid argument', message: 'Request body is not JSON', stacktrace: '' });

            return;
        }

        log.push({ method: request.method, path: url.pathname, body });
        const parts = url.pathname.split('/').filter(Boolean);

        if (request.method === 'GET' && url.pathname === '/status') {
            send(response, 200, { ready: true, message: 'fake webdriver ready' });

            return;
        }

        if (request.method === 'POST' && url.pathname === '/session') {
            if (options.failSession) {
                send(response, 500, {
                    error: options.failSession.error,
                    message: options.failSession.message,
                    stacktrace: '',
                });

                return;
            }

            sessionCounter += 1;
            const id = `fake-session-${sessionCounter}`;
            const requested = body?.capabilities?.alwaysMatch ?? null;
            const session = {
                id,
                requested,
                rawBody: body,
                capabilities: {
                    ...(requested || {}),
                    ...(options.returnedCapabilities || {}),
                },
                navigations: [],
                clicks: [],
                timeouts: { script: 30_000, pageLoad: 300_000, implicit: 0 },
                timeoutsSet: [],
                asyncTimeouts: [],
                deleted: false,
                sandbox: sandboxFor(page),
            };

            sessions.set(id, session);
            send(response, 200, { sessionId: id, capabilities: session.capabilities });

            return;
        }

        const session = parts[0] === 'session' ? sessions.get(parts[1]) : null;

        if (parts[0] === 'session' && parts[1] && !session) {
            send(response, 404, { error: 'invalid session id', message: `No session ${parts[1]}`, stacktrace: '' });

            return;
        }

        if (request.method === 'DELETE' && parts.length === 2 && session) {
            session.deleted = true;
            sessions.delete(session.id);
            send(response, 200, null);

            return;
        }

        if (request.method === 'POST' && parts.length === 3 && parts[2] === 'url' && session) {
            session.navigations.push(body?.url);
            send(response, 200, null);

            return;
        }

        if (request.method === 'POST' && parts.length === 3 && parts[2] === 'timeouts' && session) {
            session.timeoutsSet.push(body || {});

            if (body?.script != null) {
                session.timeouts.script = body.script;
            }

            if (body?.pageLoad != null) {
                session.timeouts.pageLoad = body.pageLoad;
            }

            if (body?.implicit != null) {
                session.timeouts.implicit = body.implicit;
            }

            send(response, 200, null);

            return;
        }

        if (request.method === 'POST' && parts.length === 3 && parts[2] === 'element' && session) {
            const matches = matchButtons(page, body?.value || '');

            if (matches.length === 0) {
                send(response, 404, {
                    error: 'no such element',
                    message: `No element matches ${body?.value}`,
                    stacktrace: '',
                });

                return;
            }

            send(response, 200, elementReference(matches[0], sequence));

            return;
        }

        if (request.method === 'POST' && parts.length === 3 && parts[2] === 'elements' && session) {
            const matches = matchButtons(page, body?.value || '');

            send(response, 200, matches.map((button) => elementReference(button, sequence)));

            return;
        }

        if (request.method === 'POST' && parts.length === 5 && parts[2] === 'element' && parts[4] === 'click' && session) {
            const button = page.buttons.find((entry) => entry.id === decodeURIComponent(parts[3]));

            if (!button) {
                send(response, 404, { error: 'stale element reference', message: 'Element is gone', stacktrace: '' });

                return;
            }

            session.clicks.push(button.key);
            page.state.clicks.push(button.key);
            send(response, 200, null);

            return;
        }

        // Touch tap (iOS simulator): the runner reads the element's rect, then performs a pointer action there.
        if (request.method === 'GET' && parts.length === 5 && parts[2] === 'element' && parts[4] === 'rect' && session) {
            const button = page.buttons.find((entry) => entry.id === decodeURIComponent(parts[3]));
            if (!button) {
                send(response, 404, { error: 'stale element reference', message: 'Element is gone', stacktrace: '' });
                return;
            }
            session.tapTarget = button;
            send(response, 200, { x: 10, y: 20, width: 300, height: 44 });
            return;
        }

        if (parts.length === 3 && parts[2] === 'actions' && session) {
            if (request.method === 'POST' && session.tapTarget) {
                session.clicks.push(session.tapTarget.key);
                page.state.clicks.push(session.tapTarget.key);
                session.taps = (session.taps || 0) + 1;
                session.tapTarget = null;
            }
            send(response, 200, null);
            return;
        }

        if (request.method === 'POST' && parts.length === 4 && parts[2] === 'execute' && parts[3] === 'sync' && session
            && String(body?.script || '').includes('getBoundingClientRect')) {
            // The touch tap's scroll-and-measure script: remember the target, report an on-screen rect.
            const ref = (body?.args || [])[0] || {};
            const id = ref['element-6066-11e4-a52e-4f735466cecf'] || ref.ELEMENT;
            const button = page.buttons.find((entry) => entry.id === id);
            if (!button) {
                send(response, 404, { error: 'stale element reference', message: 'Element is gone', stacktrace: '' });
                return;
            }
            session.tapTarget = button;
            send(response, 200, { x: 10, y: 300, width: 300, height: 44 });
            return;
        }

        if (request.method === 'POST' && parts.length === 4 && parts[2] === 'execute' && parts[3] === 'sync' && session) {
            try {
                const value = runInPage(body?.script || '', body?.args || [], session.sandbox);
                send(response, 200, value === undefined ? null : value);
            } catch (error) {
                send(response, 500, { error: 'javascript error', message: error.message, stacktrace: error.stack || '' });
            }

            return;
        }

        if (request.method === 'POST' && parts.length === 4 && parts[2] === 'execute' && parts[3] === 'async' && session) {
            const scriptTimeout = session.timeouts.script;
            session.asyncTimeouts.push(scriptTimeout);

            try {
                const value = await new Promise((resolve, reject) => {
                    let settled = false;
                    const timer = setTimeout(() => {
                        if (settled) {
                            return;
                        }

                        settled = true;
                        timers.delete(timer);
                        const error = new Error(`script timeout after ${scriptTimeout} ms`);
                        error.wdError = 'script timeout';
                        reject(error);
                    }, scriptTimeout);

                    timers.add(timer);

                    try {
                        runInPage(body?.script || '', [...(body?.args || []), (result) => {
                            if (settled) {
                                return;
                            }

                            settled = true;
                            clearTimeout(timer);
                            timers.delete(timer);
                            resolve(result);
                        }], session.sandbox);
                    } catch (error) {
                        if (settled) {
                            return;
                        }

                        settled = true;
                        clearTimeout(timer);
                        timers.delete(timer);
                        reject(error);
                    }
                });

                send(response, 200, value === undefined ? null : value);
            } catch (error) {
                const code = error.wdError || 'javascript error';
                send(response, 500, { error: code, message: error.message, stacktrace: error.stack || '' });
            }

            return;
        }

        send(response, 404, { error: 'unknown command', message: `${request.method} ${url.pathname}`, stacktrace: '' });
    }

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });

    const { port } = server.address();

    return {
        url: `http://127.0.0.1:${port}`,
        log,
        page,
        sessions() {
            return [...sessions.values()];
        },
        async close() {
            for (const timer of timers) {
                clearTimeout(timer);
            }

            await new Promise((resolve) => server.close(resolve));
        },
    };
}
