#!/usr/bin/env node
// Android Chrome runner for the audio matrix.
// Date: 2026-11-20. Owner: audio-matrix R2.
//
// chromedriver on the host, Chrome on the emulator via goog:chromeOptions.androidPackage
// com.android.chrome. The emulator reaches the host loopback as 10.0.2.2, so the page is
// opened there. POST /results stays on 127.0.0.1 because the matrix server is loopback-only.
//
// chromedriver resolution (no npm dependencies) is documented in lib/chromedriver.mjs:
// $CHROMEDRIVER, then PATH, then a Chrome for Testing download matched to the device
// Chrome major from latest-versions-per-milestone-with-downloads.json.

import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
    assertChromeInstalled,
    resolveChromedriver,
    writeChromeCommandLine,
} from '../lib/chromedriver.mjs';
import {
    ROW_TIMEOUT_MS,
    androidCapabilities,
    assertHttpBase,
    driveMatrix,
    identifyAndroid,
    withHostname,
} from '../lib/drive.mjs';
import { freePort, startProcess, waitForWebDriver, waitUntilReady } from '../lib/webdriver.mjs';

const USAGE = `Usage: node android-chrome.mjs [--base http://127.0.0.1:8765] [--out out] [--serial <adb-serial>] [--chrome-version <x.y.z.w>]

Drives Chrome on an Android emulator (com.android.chrome) with a real WebDriver click per row.
The device opens http://10.0.2.2:<port>/ (the emulator alias of the host loopback).
Results are posted to http://127.0.0.1:<port>/results on the host.

--serial          adb serial, sent as goog:chromeOptions.androidDeviceSerial when set.
--chrome-version  Device Chrome version, if adb dumpsys should not be used to discover it.
--base            Host harness origin. Defaults to http://127.0.0.1:8765.
--out             Directory for <label>.json. Defaults to out.

chromedriver: $CHROMEDRIVER, else PATH, else downloaded for the device Chrome major from
Chrome for Testing (see lib/chromedriver.mjs). No npm dependencies.
Label: android-chrome-<version>.
`;

export function parseArgs(argv) {
    const options = {
        base: 'http://127.0.0.1:8765',
        out: 'out',
        serial: '',
        chromeVersion: '',
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

        if (arg === '--base') {
            options.base = next();
        } else if (arg === '--out') {
            options.out = next();
        } else if (arg === '--serial' || arg === '--udid') {
            options.serial = next();
        } else if (arg === '--chrome-version') {
            options.chromeVersion = next();
        } else if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else {
            throw new Error(`Unknown argument ${arg}`);
        }
    }

    return options;
}

export async function run(options = {}) {
    const base = options.base || 'http://127.0.0.1:8765';
    const outDir = options.out || 'out';
    const serial = options.serial || '';
    const driverUrl = options.driverUrl || process.env.AUDIO_MATRIX_DRIVER_URL || '';
    const rowTimeoutMs = options.rowTimeoutMs || ROW_TIMEOUT_MS;

    assertHttpBase(base);

    let spawned = null;

    try {
        let url = driverUrl;

        if (!url) {
            // Absent Chrome is infra. Do this before a download so a missing package fails fast.
            await assertChromeInstalled({ serial });

            try {
                await writeChromeCommandLine({ serial });
            } catch (error) {
                process.stderr.write(
                    `Could not write /data/local/tmp/chrome-command-line (${error.message}). Continuing with chromeOptions args.\n`,
                );
            }

            const resolved = await resolveChromedriver({
                serial,
                chromeVersion: options.chromeVersion || undefined,
            });
            const port = await freePort();

            spawned = startProcess(resolved.path, [`--port=${port}`]);
            url = `http://127.0.0.1:${port}`;
            await waitUntilReady(spawned, url, {
                name: 'chromedriver',
                hint: `Started ${resolved.source} binary ${resolved.path}.`,
            });
        } else {
            await waitForWebDriver(url, { name: 'WebDriver' });
        }

        return await driveMatrix({
            webdriverUrl: url,
            capabilities: androidCapabilities(serial),
            // 10.0.2.2 is the Android emulator's alias for the host's loopback.
            navigateBase: withHostname(base, '10.0.2.2'),
            resultsBase: withHostname(base, '127.0.0.1'),
            outDir,
            identify: identifyAndroid,
            rowTimeoutMs,
            readyTimeoutMs: options.readyTimeoutMs || rowTimeoutMs,
        });
    } finally {
        spawned?.stop();
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
