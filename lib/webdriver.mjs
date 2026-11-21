// W3C WebDriver client for the audio matrix runners.
// Date: 2026-11-20. Owner: audio-matrix R2.
// Node built-in fetch only — the contract forbids dependencies.
//
// Safari capability names (checked against the sources, not guessed):
// - WebKit blog 9395: platformName "ios", extension safari:useSimulator true.
// - safaridriver(1): platformName "iOS" | "macOS", safari:useSimulator, safari:deviceUDID.
//   Values are compared case-insensitively, so the blog's "ios" and the man page's "iOS" match.
// - The runner sends the man-page spelling platformName "iOS", which is also the spelling in
//   WebKit bug 322970's working session trace, and browserName "safari".
// Apple's WebDriver article: only one Safari session can be attached at a time. The Safari
// runner holds a lock across the session for that reason.

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

export const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf';

export class WebDriverError extends Error {
    constructor(message, { error = 'unknown error', status = 0, endpoint = '' } = {}) {
        super(message);
        this.name = 'WebDriverError';
        this.code = error;
        this.status = status;
        this.endpoint = endpoint;
    }
}

export function delay(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

export function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close((error) => (error ? reject(error) : resolve(port)));
        });
    });
}

/**
 * @param {string} baseUrl origin of safaridriver or chromedriver, no trailing path
 * @param {{ commandTimeoutMs?: number }} [options]
 */
export class WebDriver {
    constructor(baseUrl, { commandTimeoutMs = 30_000 } = {}) {
        this.baseUrl = String(baseUrl).replace(/\/$/, '');
        this.commandTimeoutMs = commandTimeoutMs;
        this.sessionId = null;
        this.capabilities = null;
    }

    async status() {
        return this.#request('GET', '/status');
    }

    async newSession(capabilities) {
        const value = await this.#request('POST', '/session', {
            capabilities: { alwaysMatch: capabilities },
        });
        const sessionId = value?.sessionId;

        if (!sessionId) {
            throw new WebDriverError('WebDriver newSession returned no session id', {
                error: 'session not created',
                endpoint: 'POST /session',
            });
        }

        this.sessionId = sessionId;
        this.capabilities = value.capabilities ?? {};

        return { sessionId, capabilities: this.capabilities };
    }

    async navigate(url) {
        this.#requireSession();
        await this.#request('POST', `/session/${this.sessionId}/url`, { url });
    }

    /** @param {string} selector CSS selector. W3C using strategy is "css selector". */
    async findElement(selector) {
        this.#requireSession();
        const value = await this.#request('POST', `/session/${this.sessionId}/element`, {
            using: 'css selector',
            value: selector,
        });

        return elementId(value);
    }

    async findElements(selector) {
        this.#requireSession();
        const value = await this.#request('POST', `/session/${this.sessionId}/elements`, {
            using: 'css selector',
            value: selector,
        });

        if (!Array.isArray(value)) {
            throw new WebDriverError('Find elements returned no list', {
                error: 'unknown error',
                endpoint: `POST /session/${this.sessionId}/elements`,
            });
        }

        return value.map((entry) => elementId(entry));
    }

    async click(id) {
        this.#requireSession();
        await this.#request('POST', `/session/${this.sessionId}/element/${encodeURIComponent(id)}/click`, {});
    }

    /** A touch tap at the element's centre (W3C Actions, pointerType touch): iOS Safari ignores element click. */
    async tap(id) {
        this.#requireSession();
        // Element rect is in page coordinates; a viewport-origin tap needs the on-screen position, so scroll the
        // button to the middle first and read its client rect.
        const r = await this.executeScript(
            // On iOS a tap after scrolling misses (the first, unscrolled tap worked): move this row to the top of
            // its table and scroll to the top, so every tap lands where the first one did. Row order doesn't matter.
            'const e = arguments[0]; const row = e.closest("tr[data-row]");'
            + ' if (row && row.parentNode) { const first = row.parentNode.querySelector("tr[data-row]");'
            + ' if (first && first !== row) row.parentNode.insertBefore(row, first); }'
            + ' window.scrollTo(0, 0); const b = e.getBoundingClientRect();'
            + ' return { x: b.left, y: b.top, width: b.width, height: b.height };',
            [{ [ELEMENT_KEY]: id }],
        );
        const x = Math.round(r.x + r.width / 2);
        const y = Math.round(r.y + r.height / 2);
        await this.#request('POST', `/session/${this.sessionId}/actions`, {
            actions: [{
                type: 'pointer',
                id: 'finger1',
                parameters: { pointerType: 'touch' },
                actions: [
                    { type: 'pointerMove', duration: 0, origin: 'viewport', x, y },
                    { type: 'pointerDown', button: 0 },
                    { type: 'pause', duration: 60 },
                    { type: 'pointerUp', button: 0 },
                ],
            }],
        });
        await this.#request('DELETE', `/session/${this.sessionId}/actions`).catch(() => {});
    }

    async setTimeouts({ script, pageLoad, implicit } = {}) {
        this.#requireSession();
        const body = {};

        if (script !== undefined) {
            body.script = script;
        }

        if (pageLoad !== undefined) {
            body.pageLoad = pageLoad;
        }

        if (implicit !== undefined) {
            body.implicit = implicit;
        }

        await this.#request('POST', `/session/${this.sessionId}/timeouts`, body);
    }

    async executeScript(script, args = []) {
        this.#requireSession();

        return this.#request('POST', `/session/${this.sessionId}/execute/sync`, { script, args });
    }

    /**
     * Runs an async script. timeoutMs is the W3C script timeout (the 40 s row cap uses this)
     * and the HTTP call is allowed a few extra seconds so a script-timeout error can come back
     * instead of the socket being aborted first.
     */
    async executeAsyncScript(script, args = [], { timeoutMs = 30_000 } = {}) {
        this.#requireSession();
        await this.setTimeouts({ script: timeoutMs });

        return this.#request(
            'POST',
            `/session/${this.sessionId}/execute/async`,
            { script, args },
            timeoutMs + 5_000,
        );
    }

    async deleteSession() {
        if (!this.sessionId) {
            return;
        }

        const id = this.sessionId;
        this.sessionId = null;

        try {
            await this.#request('DELETE', `/session/${id}`);
        } catch (error) {
            // The session is already gone, or the driver has exited. Either way the local
            // side must not keep using it.
            if (error instanceof WebDriverError && (error.status === 404 || error.code === 'invalid session id')) {
                return;
            }

            throw error;
        }
    }

    #requireSession() {
        if (!this.sessionId) {
            throw new WebDriverError('No WebDriver session', {
                error: 'invalid session id',
                endpoint: '',
            });
        }
    }

    async #request(method, pathname, body, timeoutMs = this.commandTimeoutMs) {
        const endpoint = `${method} ${pathname}`;
        let response;

        try {
            response = await fetch(`${this.baseUrl}${pathname}`, {
                method,
                headers: body === undefined ? undefined : { 'content-type': 'application/json' },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (error) {
            const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';

            throw new WebDriverError(
                timedOut
                    ? `WebDriver ${endpoint} timed out after ${timeoutMs} ms`
                    : `WebDriver ${endpoint} failed: ${error?.message || error}`,
                { error: timedOut ? 'timeout' : 'unknown error', endpoint },
            );
        }

        const text = await response.text();
        let payload = null;

        if (text.trim() !== '') {
            try {
                payload = JSON.parse(text);
            } catch {
                throw new WebDriverError(
                    `WebDriver ${endpoint} returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`,
                    { error: 'unknown error', status: response.status, endpoint },
                );
            }
        }

        const value = payload && typeof payload === 'object' ? payload.value : null;
        const protocolError = value && typeof value === 'object' && !Array.isArray(value) && typeof value.error === 'string'
            ? value.error
            : null;

        if (!response.ok || protocolError) {
            const code = protocolError || `http ${response.status}`;
            const message = (value && typeof value === 'object' && value.message) || response.statusText || code;

            throw new WebDriverError(`${code}: ${message} (${endpoint})`, {
                error: code,
                status: response.status,
                endpoint,
            });
        }

        return value;
    }
}

function elementId(value) {
    const id = value && typeof value === 'object' ? value[ELEMENT_KEY] || value.ELEMENT : null;

    if (!id) {
        throw new WebDriverError('WebDriver returned no element reference', { error: 'no such element' });
    }

    return id;
}

/**
 * One status probe. ready:false means the process is up but not accepting sessions yet.
 */
export async function probeStatus(baseUrl, timeoutMs = 1_000) {
    const driver = new WebDriver(baseUrl, { commandTimeoutMs: timeoutMs });
    const status = await driver.status();

    if (status && status.ready === false) {
        throw new WebDriverError(status.message || 'WebDriver is not ready', { error: 'timeout', endpoint: 'GET /status' });
    }

    return status;
}

export async function waitForWebDriver(baseUrl, { timeoutMs = 20_000, intervalMs = 200, name = 'WebDriver', hint = '' } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError;

    while (Date.now() < deadline) {
        try {
            return await probeStatus(baseUrl, Math.min(2_000, timeoutMs));
        } catch (error) {
            lastError = error;
        }

        await delay(intervalMs);
    }

    throw new WebDriverError(
        `${name} at ${baseUrl} did not become ready within ${timeoutMs} ms. ${hint} ${lastError ? lastError.message : ''}`.replace(/\s+/g, ' ').trim(),
        { error: 'timeout', endpoint: 'GET /status' },
    );
}

/**
 * Spawn a driver binary and remember its output so a failed start names the cause.
 * @returns {{ done: Promise<{code: number|null, signal: NodeJS.Signals|null, error: Error|null}>, output: () => string, state: () => object|null, stop: () => void }}
 */
export function startProcess(command, args) {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const take = (chunk) => {
        output = `${output}${chunk.toString()}`.slice(-8_000);
    };

    child.stdout?.on('data', take);
    child.stderr?.on('data', take);

    let settled = null;
    const done = new Promise((resolve) => {
        const finish = (info) => {
            if (settled) {
                return;
            }

            settled = info;
            resolve(info);
        };

        child.once('error', (error) => finish({ code: null, signal: null, error }));
        child.once('exit', (code, signal) => finish({ code, signal, error: null }));
    });

    return {
        done,
        output: () => output,
        state: () => settled,
        stop() {
            if (!settled?.error && child.exitCode === null && child.signalCode === null) {
                child.kill('SIGTERM');
            }
        },
    };
}

export async function waitUntilReady(proc, baseUrl, { name, timeoutMs = 20_000, hint = '' } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError;

    while (Date.now() < deadline) {
        const state = proc.state();

        if (state) {
            const why = state.error ? state.error.message : (state.signal || state.code);

            throw new WebDriverError(
                `${name} stopped before it was ready (${why}). ${hint} ${proc.output()}`.replace(/\s+/g, ' ').trim(),
                { error: 'session not created' },
            );
        }

        try {
            return await probeStatus(baseUrl, 1_000);
        } catch (error) {
            lastError = error;
        }

        await delay(200);
    }

    proc.stop();

    throw new WebDriverError(
        `${name} did not become ready within ${timeoutMs} ms. ${hint} ${lastError ? lastError.message : ''} ${proc.output()}`.replace(/\s+/g, ' ').trim(),
        { error: 'timeout' },
    );
}
