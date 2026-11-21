// Locate a chromedriver whose major version matches the device Chrome.
// Date: 2026-11-20. Owner: audio-matrix R2.
//
// Order, with no npm packages:
// 1. $CHROMEDRIVER, if it points at a binary.
// 2. chromedriver on PATH.
// 3. Otherwise download Chrome for Testing's chromedriver for the device's Chrome major.
//
// Since Chrome 115, chromedriver's major must equal Chrome's major. Chrome for Testing
// publishes one catalogue of the latest patch per milestone:
//   https://googlechromelabs.github.io/chrome-for-testing/latest-versions-per-milestone-with-downloads.json
// Shape: { milestones: { "<major>": { version, downloads: { chromedriver: [{ platform, url }] } } } }
// Platforms: linux64, linux-arm64, mac-x64, mac-arm64, win32, win64.
// The zip is fetched only from storage.googleapis.com (the host that catalogue uses) and
// extracted with node:zlib. The catalogue is small, so it is read again on later runs;
// the zip is cached by the resolved version. Milestones below 115 have no chromedriver here.
//
// The zip's internal path is not used as a filesystem path, so a hostile archive cannot
// write outside the cache directory.

import { access, chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile as execFileCallback, execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';

const execFile = promisify(execFileCallback);

export const CFT_MILESTONES_URL = 'https://googlechromelabs.github.io/chrome-for-testing/latest-versions-per-milestone-with-downloads.json';

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);

    for (let n = 0; n < 256; n += 1) {
        let crc = n;

        for (let k = 0; k < 8; k += 1) {
            crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
        }

        table[n] = crc >>> 0;
    }

    return table;
})();

function crc32(buffer) {
    let crc = 0xffffffff;

    for (let i = 0; i < buffer.length; i += 1) {
        crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
    }

    return (crc ^ 0xffffffff) >>> 0;
}

export function cftPlatform(platform = process.platform, arch = process.arch) {
    if (platform === 'linux' && arch === 'x64') {
        return 'linux64';
    }

    if (platform === 'linux' && arch === 'arm64') {
        return 'linux-arm64';
    }

    if (platform === 'darwin' && arch === 'arm64') {
        return 'mac-arm64';
    }

    if (platform === 'darwin' && arch === 'x64') {
        return 'mac-x64';
    }

    if (platform === 'win32' && arch === 'x64') {
        return 'win64';
    }

    if (platform === 'win32' && arch === 'ia32') {
        return 'win32';
    }

    throw new Error(`No Chrome for Testing chromedriver build for ${platform}/${arch}.`);
}

export function pickChromedriverDownload(catalog, chromeVersion, platformName) {
    const major = String(chromeVersion).split('.')[0];
    const milestone = catalog?.milestones?.[major];

    if (!milestone) {
        throw new Error(
            `Chrome for Testing has no milestone ${major} for device Chrome ${chromeVersion}. `
            + 'Chrome 114 and older are not in this catalogue; put a matching chromedriver on PATH.',
        );
    }

    const list = milestone.downloads?.chromedriver || [];
    const hit = list.find((item) => item.platform === platformName);

    if (!hit?.url) {
        throw new Error(
            `Chrome for Testing milestone ${major} (${milestone.version}) has no chromedriver for ${platformName}.`,
        );
    }

    let url;

    try {
        url = new URL(hit.url);
    } catch {
        throw new Error(`Chrome for Testing chromedriver URL is not valid: ${hit.url}`);
    }

    if (url.protocol !== 'https:' || url.hostname !== 'storage.googleapis.com') {
        throw new Error(`Refusing chromedriver URL outside storage.googleapis.com: ${hit.url}`);
    }

    return { version: milestone.version, url: hit.url, platform: platformName, major };
}

export async function findOnPath(name, pathEnv = process.env.PATH || '') {
    const names = process.platform === 'win32' ? [`${name}.exe`, name] : [name];

    for (const dir of pathEnv.split(path.delimiter)) {
        if (!dir) {
            continue;
        }

        for (const candidate of names) {
            const full = path.join(dir, candidate);

            try {
                await access(full, constants.X_OK);

                return full;
            } catch {
                // Another directory may still contain it.
            }
        }
    }

    return null;
}

function findEocd(buffer) {
    const min = Math.max(0, buffer.length - 22 - 65_535);

    for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
        if (buffer.readUInt32LE(offset) === 0x06054b50) {
            return offset;
        }
    }

    throw new Error('chromedriver zip has no end of central directory.');
}

/**
 * Returns the uncompressed bytes of the first entry whose name matches predicate.
 * Reads sizes from the central directory so data-descriptor entries still work.
 */
export function extractZipEntry(buffer, predicate) {
    const eocd = findEocd(buffer);
    const count = buffer.readUInt16LE(eocd + 10);
    let offset = buffer.readUInt32LE(eocd + 16);

    if (count === 0xffff || offset === 0xffffffff) {
        throw new Error('chromedriver zip is ZIP64, which this extractor does not read. Place chromedriver on PATH.');
    }

    for (let index = 0; index < count; index += 1) {
        if (buffer.readUInt32LE(offset) !== 0x02014b50) {
            throw new Error('chromedriver zip central directory is truncated.');
        }

        const method = buffer.readUInt16LE(offset + 10);
        const crc = buffer.readUInt32LE(offset + 16);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const uncompressedSize = buffer.readUInt32LE(offset + 24);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localOffset = buffer.readUInt32LE(offset + 42);
        const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

        offset += 46 + nameLength + extraLength + commentLength;

        if (!predicate(name)) {
            continue;
        }

        if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) {
            throw new Error('chromedriver zip entry is ZIP64. Place chromedriver on PATH.');
        }

        if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
            throw new Error(`chromedriver zip entry ${name} has no local header.`);
        }

        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
        let data;

        if (method === 0) {
            data = Buffer.from(compressed);
        } else if (method === 8) {
            data = inflateRawSync(compressed);
        } else {
            throw new Error(`chromedriver zip entry ${name} uses compression method ${method}.`);
        }

        if (data.length !== uncompressedSize || crc32(data) !== crc) {
            throw new Error(`chromedriver zip entry ${name} failed its checksum.`);
        }

        return data;
    }

    return null;
}

export async function downloadChromedriver({ url, version, cacheDir, fetchImpl = globalThis.fetch }) {
    const binName = process.platform === 'win32' ? 'chromedriver.exe' : 'chromedriver';
    const dest = path.join(cacheDir, version, binName);

    try {
        await access(dest, constants.X_OK);

        return dest;
    } catch {
        // Not cached yet.
    }

    const response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });

    if (!response.ok) {
        throw new Error(`chromedriver download failed: HTTP ${response.status} ${url}`);
    }

    const zipped = Buffer.from(await response.arrayBuffer());
    const data = extractZipEntry(zipped, (name) => /(^|\/)chromedriver(\.exe)?$/.test(name));

    if (!data) {
        throw new Error('chromedriver zip did not contain a chromedriver binary.');
    }

    const directory = path.dirname(dest);
    const temporary = path.join(directory, `.${binName}.${process.pid}.part`);

    await mkdir(directory, { recursive: true });
    await writeFile(temporary, data);
    await chmod(temporary, 0o755);
    await rename(temporary, dest);

    return dest;
}

async function runAdb(exec, serial, args) {
    const prefix = serial ? ['-s', serial] : [];

    return exec('adb', [...prefix, ...args], { encoding: 'utf8', timeout: 20_000 });
}

/**
 * If com.android.chrome is absent the run is infra. There is no APK fallback.
 */
export async function assertChromeInstalled({ serial, execFile: exec = execFile } = {}) {
    const result = await runAdb(exec, serial, ['shell', 'pm', 'path', 'com.android.chrome']);
    const stdout = String(result.stdout || '');

    if (!stdout.includes('package:')) {
        throw new Error(
            'com.android.chrome is not installed (pm path returned nothing). '
            + 'This run is infra. The matrix does not fall back to a sideloaded Chrome APK.',
        );
    }
}

export async function readDeviceChromeVersion({ serial, execFile: exec = execFile } = {}) {
    await assertChromeInstalled({ serial, execFile: exec });
    const result = await runAdb(exec, serial, ['shell', 'dumpsys', 'package', 'com.android.chrome']);
    const match = String(result.stdout || '').match(/versionName=(\d+(?:\.\d+)*)/);

    if (!match) {
        throw new Error('Could not read Chrome versionName from the device (dumpsys package com.android.chrome).');
    }

    return match[1];
}

/**
 * Suppress the first-run UI with a command-line flags file. chromeOptions args are
 * also set; this file covers the case where Android Chrome ignores those args.
 */
export async function writeChromeCommandLine({ serial, execFile: exec = execFile } = {}) {
    const line = 'chrome --disable-fre --no-default-browser-check --no-first-run';

    await runAdb(exec, serial, [
        'shell',
        `echo '${line}' > /data/local/tmp/chrome-command-line`,
    ]);
}

const LEGACY_STORE = 'https://chromedriver.storage.googleapis.com';

/** Major version of a chromedriver binary ('' when it can't be read). */
export function chromedriverVersion(bin) {
    try {
        const out = execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 });
        return (out.match(/ChromeDriver (\d+)\./) || [])[1] || '';
    } catch {
        return '';
    }
}

export async function resolveChromedriver(options = {}) {
    const env = options.env ?? process.env;

    if (env.CHROMEDRIVER) {
        return { path: env.CHROMEDRIVER, source: 'CHROMEDRIVER' };
    }

    const version = options.chromeVersion || await readDeviceChromeVersion(options);
    const major = String(version).split('.')[0];
    const find = options.findOnPath ?? findOnPath;
    const found = await find('chromedriver');

    // A chromedriver on PATH only counts if it drives this Chrome: GitHub's Ubuntu image carries the desktop
    // Chrome's driver (157 in Nov 2026), while the API 34 Play Store image ships Chrome 113.
    if (found) {
        const pathMajor = (options.driverVersion ?? chromedriverVersion)(found);
        if (pathMajor === major) {
            return { path: found, source: 'PATH' };
        }
    }

    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const cacheDirLegacy = options.cacheDir || path.join(tmpdir(), 'audio-matrix-chromedriver');

    // Chrome for Testing starts at 115; older drivers live on the legacy store (same host, storage.googleapis.com).
    if (Number(major) <= 114) {
        const latest = await fetchImpl(`${LEGACY_STORE}/LATEST_RELEASE_${major}`, { signal: AbortSignal.timeout(30_000) });
        if (!latest.ok) {
            throw new Error(`Legacy chromedriver store has no release for Chrome ${major}: HTTP ${latest.status}`);
        }
        const legacyVersion = (await latest.text()).trim();
        if (!/^\d+\.\d+\.\d+\.\d+$/.test(legacyVersion)) {
            throw new Error(`Legacy chromedriver store returned an unexpected version: ${legacyVersion.slice(0, 40)}`);
        }
        const legacyPlatform = { 'linux64': 'linux64', 'mac-x64': 'mac64', 'mac-arm64': 'mac_arm64', 'win64': 'win32', 'win32': 'win32' }[options.platform || cftPlatform()];
        const bin = await downloadChromedriver({
            url: `${LEGACY_STORE}/${legacyVersion}/chromedriver_${legacyPlatform}.zip`,
            version: legacyVersion,
            cacheDir: cacheDirLegacy,
            fetchImpl,
        });
        return { path: bin, source: 'legacy-store', version: legacyVersion };
    }
    const response = await fetchImpl(CFT_MILESTONES_URL, { signal: AbortSignal.timeout(30_000) });

    if (!response.ok) {
        throw new Error(`Chrome for Testing JSON failed: HTTP ${response.status} ${CFT_MILESTONES_URL}`);
    }

    const catalog = await response.json();
    const platformName = options.platform || cftPlatform();
    const picked = pickChromedriverDownload(catalog, version, platformName);
    const cacheDir = options.cacheDir || path.join(tmpdir(), 'audio-matrix-chromedriver');
    const bin = await downloadChromedriver({
        url: picked.url,
        version: picked.version,
        cacheDir,
        fetchImpl,
    });

    return { path: bin, source: 'chrome-for-testing', version: picked.version };
}
