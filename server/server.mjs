import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
    options: {
        port: { type: 'string', default: '8765' },
        host: { type: 'string', default: '127.0.0.1' },
        out: { type: 'string', default: resolve(root, 'out') },
    },
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('Invalid port');
const out = resolve(values.out);
const manifestBytes = await readFile(resolve(root, 'fixtures/manifest.json'));
const manifest = JSON.parse(manifestBytes);
const media = new Map();
const requests = new Map(manifest.items.map((item) => [item.id, []]));

// Only manifest entries become file paths; URL components never reach the filesystem.
for (const item of manifest.items) {
    for (const rendition of ['original', 'playback']) {
        if (!item[rendition]?.file) continue;
        for (const variant of ['live', 'no-cache', 'as-stored']) {
            if (variant === 'as-stored' && rendition !== 'original') continue;
            const path = resolve(root, 'fixtures', item[rendition].file);
            const rel = relative(resolve(root, 'fixtures'), path);
            if (rel.startsWith('..') || isAbsolute(rel))
                throw new Error('Invalid manifest path');
            media.set(`/f/${variant}/${item.id}/${rendition}`, {
                path,
                item: item.id,
                mime:
                    variant === 'as-stored'
                        ? item.stored_mime
                        : rendition === 'playback'
                          ? 'audio/mp4'
                          : item.original.mime,
                cache:
                    variant === 'no-cache'
                        ? 'no-cache, private'
                        : 'no-store, private',
            });
        }
    }
}
const assets = new Map([
    ['/', [resolve(root, 'harness/index.html'), 'text/html; charset=utf-8']],
    [
        '/harness.js',
        [resolve(root, 'harness/harness.js'), 'text/javascript; charset=utf-8'],
    ],
    [
        '/harness/harness.js',
        [resolve(root, 'harness/harness.js'), 'text/javascript; charset=utf-8'],
    ],
]);

function reply(req, res, status, body, type = 'text/plain; charset=utf-8') {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    res.writeHead(status, {
        'Content-Type': type,
        'Content-Length': bytes.length,
    });
    res.end(req.method === 'HEAD' ? undefined : bytes);
}

// PHP's integer cast consumes a numeric prefix, including on a multi-range end.
function phpInt(value) {
    const number = Number.parseFloat(value);
    return Number.isNaN(number) ? 0 : Math.trunc(number);
}

async function serveMedia(req, res, entry) {
    const file = await stat(entry.path);
    const size = file.size;
    const modified = new Date(
        Math.floor(file.mtimeMs / 1000) * 1000,
    ).toUTCString();
    const headers = {
        'Content-Type': entry.mime,
        'Cache-Control': entry.cache,
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
        'Accept-Ranges': 'bytes',
        'Last-Modified': modified,
        'Content-Length': size,
    };
    let status = 200;
    let start = 0;
    let end = size - 1;
    const range = req.headers.range;
    if (
        req.method === 'GET' &&
        range?.startsWith('bytes=') &&
        (req.headers['if-range'] === undefined ||
            req.headers['if-range'] === modified)
    ) {
        const spec = range.slice(6);
        const dash = spec.indexOf('-');
        const first = dash === -1 ? spec : spec.slice(0, dash);
        const last = dash === -1 ? '0' : spec.slice(dash + 1);
        let to = last === '' ? size - 1 : phpInt(last);
        let from = first === '' ? size - to : phpInt(first);
        if (first === '') to = size - 1;
        // Range rules modelled on Symfony's BinaryFileResponse::prepare (common in PHP apps).
        // Reversed/open-ended beyond EOF stays 200; multi-range parses its first end.
        if (from <= to) {
            to = Math.min(to, size - 1);
            if (from < 0 || from > to) {
                status = 416;
                headers['Content-Range'] = `bytes */${size}`;
            } else {
                status = 206;
                start = from;
                end = to;
                headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
                headers['Content-Length'] = end - start + 1;
            }
        }
    }
    const log = { range: range ?? null, status, bytes: 0 };
    requests.get(entry.item).push(log);
    res.writeHead(status, headers);
    if (req.method === 'HEAD' || status === 416 || size === 0) {
        res.end();
        return;
    }
    const stream = createReadStream(entry.path, { start, end });
    stream.on('data', (chunk) => {
        log.bytes += chunk.length;
    });
    await pipeline(stream, res);
}

function validResults(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    if (
        typeof data.runner !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(data.runner) ||
        data.runner.includes('..')
    )
        return false;
    for (const key of ['browser', 'os']) {
        if (
            !data[key] ||
            typeof data[key].name !== 'string' ||
            typeof data[key].version !== 'string'
        )
            return false;
    }
    if (
        typeof data.started_at !== 'string' ||
        typeof data.finished_at !== 'string' ||
        !Array.isArray(data.rows)
    )
        return false;
    return data.rows.every(
        (row) =>
            row &&
            typeof row.item === 'string' &&
            ['playback', 'original'].includes(row.rendition) &&
            ['live', 'no-cache', 'as-stored'].includes(row.variant) &&
            typeof row.required === 'boolean' &&
            [
                'pass',
                'fail:media',
                'fail:policy',
                'fail:stall',
                'infra',
                'missing',
            ].includes(row.outcome) &&
            row.stages &&
            typeof row.stages === 'object' &&
            !Array.isArray(row.stages),
    );
}

async function saveResults(req, res) {
    const address = req.socket.remoteAddress;
    if (!(
        address === '::1' ||
        /^127\./.test(address) ||
        /^::ffff:127\./.test(address)
    )) {
        reply(req, res, 403, 'Loopback only');
        return;
    }
    const chunks = [];
    let length = 0;
    for await (const chunk of req) {
        length += chunk.length;
        if (length > 2 * 1024 * 1024) {
            reply(req, res, 413, 'Results too large');
            return;
        }
        chunks.push(chunk);
    }
    let data;
    try {
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        reply(req, res, 400, 'Invalid JSON');
        return;
    }
    if (!validResults(data)) {
        reply(req, res, 400, 'Invalid results');
        return;
    }
    await mkdir(out, { recursive: true });
    // Rename prevents readers seeing half-written JSON and replaces rather than follows file symlinks.
    const temporary = resolve(out, `.${randomUUID()}.tmp`);
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, {
        flag: 'wx',
    });
    await rename(temporary, resolve(out, `${data.runner}.json`));
    reply(
        req,
        res,
        200,
        JSON.stringify({ saved: `${data.runner}.json` }),
        'application/json',
    );
}

const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost');
        if (req.method === 'POST' && url.pathname === '/results')
            return await saveResults(req, res);
        if (!['GET', 'HEAD'].includes(req.method))
            return reply(req, res, 405, 'Method not allowed');
        if (url.pathname === '/manifest.json')
            return reply(req, res, 200, manifestBytes, 'application/json');
        if (url.pathname === '/requests') {
            const log = requests.get(url.searchParams.get('item'));
            return reply(
                req,
                res,
                log ? 200 : 404,
                JSON.stringify(log ?? []),
                'application/json',
            );
        }
        const entry = media.get(url.pathname);
        if (entry) return await serveMedia(req, res, entry);
        const asset = assets.get(url.pathname);
        if (asset)
            return reply(req, res, 200, await readFile(asset[0]), asset[1]);
        reply(req, res, 404, 'Not found');
    } catch (error) {
        if (res.headersSent) res.destroy(error);
        else
            reply(
                req,
                res,
                error.code === 'ENOENT' ? 404 : 500,
                error.code === 'ENOENT' ? 'Not found' : 'Server error',
            );
    }
});
server.listen(port, values.host, () => {
    console.log(
        `Audio matrix server listening on http://${values.host}:${server.address().port}`,
    );
});
for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => server.close(() => process.exit(0)));
