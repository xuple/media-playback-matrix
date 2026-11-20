#!/usr/bin/env node
// Safari and iOS Simulator runner for the audio matrix.
// Date: 2026-11-20. Owner: audio-matrix R2.
//
// Starts `safaridriver -p <port>`, waits until GET /status succeeds, then one session.
// Apple documents a single attached WebDriver session, so a lock is held for the whole run.
// Capability objects match safaridriver(1)
// and WebKit blog 9395 (see lib/webdriver.mjs).

import { open, readFile, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { ROW_TIMEOUT_MS, assertHttpBase, driveMatrix, identifySafari, safariCapabilities } from '../lib/drive.mjs';
import { freePort, startProcess, waitForWebDriver, waitUntilReady } from '../lib/webdriver.mjs';

const USAGE = `Usage: node safari-webdriver.mjs --target safari|simulator [--udid <udid>] [--base http://127.0.0.1:8765] [--out out]

Opens the audio matrix in Safari and clicks each Play button with a real WebDriver click.
--target safari      macOS Safari on this machine (browserName safari).
--target simulator   iOS Simulator. Requires --udid (safari:deviceUDID). Also sends platformName iOS and safari:useSimulator true.
--base               Harness origin. Defaults to http://127.0.0.1:8765. Results are posted to <base>/results.
--out                Directory for <label>.json. Defaults to out.

Labels: safari-macos-<version> or ios-<runtime>-<device>.
Safari allows only one WebDriver session at a time.
`;

const DEFAULT_LOCK = path.join(tmpdir(), 'audio-matrix-safaridriver.lock');

export function parseArgs(argv) {
    const options = {
        target: '',
        udid: '',
        base: 'http://127.0.0.1:8765',
        out: 'out',
        help: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = () => {
            const value = argv[index + 1];

            if (value === undefined || value.startsWith('--')) {
                throw new Error(`Missing value for ${arg}`);
            }

            index += 1;

            return value;
        };

        if (arg === '--target') {
            options.target = next();
        } else if (arg === '--udid') {
            options.udid = next();
        } else if (arg === '--base') {
            options.base = next();
        } else if (arg === '--out') {
            options.out = next();
        } else if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else {
            throw new Error(`Unknown argument ${arg}`);
        }
    }

    return options;
}

function processAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }

    try {
        process.kill(pid, 0);

        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

export async function acquireSafariLock(lockPath = DEFAULT_LOCK) {
    await mkdir(path.dirname(lockPath), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const handle = await open(lockPath, 'wx');

            try {
                await handle.writeFile(`${process.pid}\n`);
            } catch (error) {
                await handle.close().catch(() => {});
                await unlink(lockPath).catch(() => {});
                throw error;
            }

            return { handle, lockPath };
        } catch (error) {
            if (error.code !== 'EEXIST') {
                throw error;
            }

            const owner = await readFile(lockPath, 'utf8').catch(() => '');
            const pid = Number(String(owner).trim().split(/\s+/)[0]);

            if (pid && !processAlive(pid)) {
                await unlink(lockPath).catch(() => {});
                continue;
            }

            throw new Error(
                `Safari allows only one WebDriver session at a time (lock ${lockPath}, pid ${pid || 'unknown'}). Stop the other run and try again.`,
            );
        }
    }

    throw new Error('Safari allows only one WebDriver session at a time.');
}

export async function releaseSafariLock(lock) {
    if (!lock) {
        return;
    }

    await lock.handle.close().catch(() => {});
    const current = await readFile(lock.lockPath, 'utf8').catch(() => '');

    if (Number(String(current).trim().split(/\s+/)[0]) === process.pid) {
        await unlink(lock.lockPath).catch(() => {});
    }
}

export async function run(options = {}) {
    const target = options.target;
    const udid = options.udid || '';
    const base = options.base || 'http://127.0.0.1:8765';
    const outDir = options.out || 'out';
    const driverUrl = options.driverUrl || process.env.AUDIO_MATRIX_DRIVER_URL || '';
    const lockPath = options.lockPath || process.env.AUDIO_MATRIX_SAFARI_LOCK || DEFAULT_LOCK;
    const rowTimeoutMs = options.rowTimeoutMs || ROW_TIMEOUT_MS;
    const capabilities = safariCapabilities(target, udid);

    assertHttpBase(base);

    // Take the lock before spawning safaridriver. A second process must fail
    // before it can attach another session to Safari.
    const lock = await acquireSafariLock(lockPath);
    let spawned = null;

    try {
        let url = driverUrl;

        if (!url) {
            const port = await freePort();
            const command = process.env.SAFARIDRIVER || 'safaridriver';

            spawned = startProcess(command, ['-p', String(port), '--diagnose']);
            url = `http://127.0.0.1:${port}`;
            await waitUntilReady(spawned, url, { timeoutMs: 60_000,
                name: 'safaridriver',
                hint: 'If this Mac has never run safaridriver, run `safaridriver --enable` once as an administrator.',
            });
        } else {
            await waitForWebDriver(url, { name: 'WebDriver' });
        }

        return await driveMatrix({
            webdriverUrl: url,
            capabilities,
            navigateBase: base,
            resultsBase: base,
            outDir,
            identify: (info) => identifySafari({ target, ...info }),
            rowTimeoutMs,
            readyTimeoutMs: options.readyTimeoutMs || rowTimeoutMs,
        });
    } finally {
        spawned?.stop();
        await releaseSafariLock(lock);
    }
}

function isMain(metaUrl) {
    const entry = process.argv[1];

    if (!entry) {
        return false;
    }

    return pathToFileURL(path.resolve(entry)).href === metaUrl;
}

function main(argv) {
    let options;

    try {
        options = parseArgs(argv);
    } catch (error) {
        process.stderr.write(`${error.message}\n${USAGE}`);
        process.exitCode = 1;

        return;
    }

    if (options.help) {
        process.stdout.write(USAGE);

        return;
    }

    run(options).then(
        (result) => {
            process.exitCode = result.exitCode;
        },
        (error) => {
            process.stderr.write(`${error.message}\n`);
            process.exitCode = 1;
        },
    );
}

if (isMain(import.meta.url)) {
    main(process.argv.slice(2));
}
