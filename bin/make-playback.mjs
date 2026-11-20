#!/usr/bin/env node
// Reference recipe for a "plays everywhere" audio copy, and the manifest the harness reads.
//
// For each file in fixtures/originals (or --dir <fixtures>/originals), makes an AAC-LC
// faststart MP4 (.m4a) in fixtures/playback and writes fixtures/manifest.json.
//   - AAC-LC, 1-2 channels, common sample rate: the audio is copied (remux only).
//   - Anything else: re-encoded to AAC-LC, mono 96k or stereo 128k, 44.1 or 48 kHz.
//   - The container is chosen from the file's magic bytes and passed to ffmpeg with -f,
//     and only the file: protocol is allowed, so ffmpeg never guesses or follows links.
// Swap in your own converter by producing playback/<name>.m4a yourself and running with
// --manifest-only. Needs ffmpeg and ffprobe on PATH. Node >= 20, no dependencies.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dirArg = args.indexOf('--dir');
const fixtures = path.resolve(dirArg >= 0 ? args[dirArg + 1] : path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures'));
const manifestOnly = args.includes('--manifest-only');
const COPY_RATES = [16000, 22050, 24000, 32000, 44100, 48000];
// What a browser reports for the file (original.mime) and what a typical server-side
// detector (libmagic) stores for it (stored_mime, served by the `as-stored` variant).
const TYPES = {
  webm: ['audio/webm', 'video/webm'], ogg: ['audio/ogg', 'audio/ogg'], opus: ['audio/ogg', 'audio/ogg'],
  mp4: ['audio/mp4', 'video/mp4'], m4a: ['audio/mp4', 'audio/x-m4a'], mp3: ['audio/mpeg', 'audio/mpeg'],
  wav: ['audio/wav', 'audio/wav'], flac: ['audio/flac', 'audio/flac'], aac: ['audio/aac', 'audio/aac'],
};

function demuxer(file) {
  const fd = fs.openSync(file, 'r');
  const h = Buffer.alloc(16);
  const n = fs.readSync(fd, h, 0, 16, 0);
  fs.closeSync(fd);
  const s = (a, b) => h.subarray(a, b).toString('latin1');
  if (n >= 4 && h.readUInt32BE(0) === 0x1a45dfa3) return 'matroska';
  if (n >= 8 && s(4, 8) === 'ftyp') return 'mov';
  if (s(0, 4) === 'OggS') return 'ogg';
  if (n >= 12 && s(0, 4) === 'RIFF' && s(8, 12) === 'WAVE') return 'wav';
  if (s(0, 4) === 'fLaC') return 'flac';
  if (s(0, 3) === 'ID3' || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0 && (h[1] & 0x06) !== 0)) return 'mp3';
  if (h[0] === 0xff && (h[1] & 0xf6) === 0xf0) return 'aac';
  return null;
}

function probe(file, demux) {
  const pre = demux ? ['-f', demux] : [];
  const out = execFileSync('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file', ...pre,
    '-show_entries', 'stream=codec_name,profile,sample_rate,channels:format=duration,format_name',
    '-select_streams', 'a:0', '-of', 'json', `file:${file}`]);
  const j = JSON.parse(out);
  const st = j.streams?.[0] ?? {};
  return {
    codec: st.codec_name ?? null, profile: st.profile ?? null,
    sample_rate: Number(st.sample_rate ?? 0), channels: Number(st.channels ?? 0),
    duration: j.format?.duration !== undefined ? Math.round(Number(j.format.duration) * 1000) / 1000 : null,
    container: j.format?.format_name ?? null,
  };
}

function convert(input, output, demux, st) {
  const copy = st.codec === 'aac' && st.profile === 'LC' && st.channels >= 1 && st.channels <= 2 && COPY_RATES.includes(st.sample_rate);
  const a = ['-nostdin', '-hide_banner', '-v', 'error', '-threads', '1', '-protocol_whitelist', 'file',
    '-f', demux, '-probesize', '5M', '-analyzeduration', '10M', '-i', `file:${input}`,
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1'];
  if (copy) {
    a.push('-c:a', 'copy');
    if (demux === 'aac') a.push('-bsf:a', 'aac_adtstoasc');
  } else {
    const ch = st.channels < 1 ? 1 : Math.min(st.channels, 2);
    const rate = st.sample_rate === 44100 ? 44100 : 48000;
    a.push('-c:a', 'aac', '-profile:a', 'aac_low', '-ac', String(ch), '-ar', String(rate), '-b:a', ch === 1 ? '96k' : '128k');
  }
  a.push('-movflags', '+faststart', '-f', 'mp4', '-y', `file:${output}`);
  execFileSync('ffmpeg', a, { stdio: ['ignore', 'ignore', 'inherit'] });
  return copy ? 'copy' : 'transcode';
}

const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const self = fileURLToPathSafe(import.meta.url);
function fileURLToPathSafe(u) { return decodeURIComponent(new URL(u).pathname); }

const manifest = {
  generated_by: 'bin/make-playback.mjs',
  recipe_sha256: sha(self),
  ffmpeg: execFileSync('ffmpeg', ['-version']).toString().split('\n')[0].trim(),
  items: [],
};
fs.mkdirSync(path.join(fixtures, 'playback'), { recursive: true });
for (const name of fs.readdirSync(path.join(fixtures, 'originals')).sort()) {
  const input = path.join(fixtures, 'originals', name);
  const ext = path.extname(name).slice(1).toLowerCase();
  const [mime, stored] = TYPES[ext] ?? ['application/octet-stream', 'application/octet-stream'];
  const demux = demuxer(input);
  const item = {
    name,
    original: { file: `originals/${name}`, mime, sha256: sha(input), demuxer: demux, ...probe(input, demux) },
  };
  const output = path.join(fixtures, 'playback', `${name}.m4a`);
  try {
    if (!demux) throw new Error('format');
    const mode = manifestOnly ? null : convert(input, output, demux, item.original);
    item.playback = { file: `playback/${name}.m4a`, mime: 'audio/mp4', mode: mode ?? 'external', sha256: sha(output), ...probe(output, 'mov') };
  } catch (e) {
    item.playback = { error: e.message === 'format' ? 'format' : 'decode' };
  }
  item.id = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  item.checks = (item.original.duration ?? item.playback.duration ?? 0) >= 45 ? ['seek'] : ['replay'];
  item.stored_mime = stored;
  manifest.items.push(item);
  process.stdout.write(`${name.padEnd(26)} ${String(item.original.codec).padEnd(9)} -> ${item.playback.mode ?? item.playback.error}\n`);
}
fs.writeFileSync(path.join(fixtures, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
