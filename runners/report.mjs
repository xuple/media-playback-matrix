// Owner: audio-matrix R1. 2026-11-20. No dependencies: only the schema keywords in the contract are needed.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const schema = JSON.parse(await readFile(new URL('../results.schema.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('../fixtures/manifest.json', import.meta.url), 'utf8'));
const keyOf = row => `${row.item}|${row.rendition}|${row.variant}`;
const required = row => row.rendition === 'playback' && row.variant === 'live';
// Columns that gate the run: Playwright's WebKit (not Safari) and bundled
// Chromium are informational, as in ci.mjs (Codex review, 20 Nov 2026).
// --gate-all makes every column gate (local runs with only those engines).
let gateAll = false;
export const gating = label => gateAll || !/(?:^|-)(?:webkit|chromium)(?:-|$)/i.test(label);
const cell = value => String(value).replace(/\|/g, '&#124;').replace(/[\r\n]+/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const reason = row => String(row.error?.message || Object.entries(row.stages)
    .find(([name, stage]) => name !== 'muted_autoplay' && stage?.ok === false)?.[1].detail || row.outcome);

export function validate(value, rule = schema, location = '$', root = schema) {
    if (rule.$ref) {
        if (!rule.$ref.startsWith('#/')) return [`${location}: unsupported schema reference`];
        const target = rule.$ref.slice(2).split('/').reduce((node, key) => node[key], root);
        return validate(value, target, location, root);
    }
    if (rule.oneOf) {
        return rule.oneOf.filter(option => validate(value, option, location, root).length === 0).length === 1
            ? [] : [`${location}: must match exactly one schema alternative`];
    }
    const types = { null: value === null, array: Array.isArray(value),
        object: value !== null && typeof value === 'object' && !Array.isArray(value),
        integer: Number.isInteger(value), number: typeof value === 'number' && Number.isFinite(value),
        string: typeof value === 'string', boolean: typeof value === 'boolean' };
    if (rule.type && ![rule.type].flat().some(type => types[type])) return [`${location}: expected ${[rule.type].flat().join(' or ')}`];
    if (rule.enum && !rule.enum.includes(value)) return [`${location}: expected ${rule.enum.join(', ')}`];
    const errors = [];
    if (types.object) {
        for (const key of rule.required ?? []) {
            if (!Object.hasOwn(value, key)) errors.push(`${location}.${key}: required`);
        }
        for (const [key, child] of Object.entries(rule.properties ?? {})) {
            if (Object.hasOwn(value, key)) errors.push(...validate(value[key], child, `${location}.${key}`, root));
        }
    }
    if (types.array && rule.items) value.forEach((item, index) => errors.push(...validate(item, rule.items, `${location}[${index}]`, root)));
    return errors;
}

export function makeReport(results, { expect = [], fixtures = manifest, errors = [] } = {}) {
    errors = [...errors];
    const runners = new Map();
    const definitions = new Map(fixtures.items.map(item => {
        const row = { item: item.id, rendition: 'playback', variant: 'live', required: true };
        return [keyOf(row), row];
    }));
    for (const result of results) {
        const invalid = validate(result);
        if (invalid.length) { errors.push(`${result?.runner ?? 'unnamed'}: ${invalid.join('; ')}`); continue; }
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(result.runner)) {
            errors.push(`Invalid runner label: ${result.runner}`); continue;
        }
        if (runners.has(result.runner)) {
            errors.push(`Duplicate runner: ${result.runner}`); continue;
        }
        const rows = new Map();
        for (const row of result.rows) {
            const key = keyOf(row);
            if (row.required !== required(row)) errors.push(`${result.runner}/${key}: invalid required flag`);
            if (rows.has(key)) errors.push(`${result.runner}/${key}: duplicate row`);
            rows.set(key, row);
            definitions.set(key, { ...row, required: required(row) });
        }
        runners.set(result.runner, { ...result, rows });
    }
    for (const label of expect) {
        if (!runners.has(label)) { errors.push(`Expected runner file missing: ${label}`); runners.set(label, { rows: new Map() }); }
    }
    if (!runners.size) errors.push('No runner results supplied');
    const labels = [...runners.keys()].sort();
    const rows = [...definitions.values()].sort((a, b) => Number(required(b)) - Number(required(a)) || keyOf(a).localeCompare(keyOf(b)));
    const failures = [];
    let passed = 0;
    let total = 0;
    let failed = errors.length > 0;
    for (const row of rows) {
        for (const label of labels) {
            const result = runners.get(label).rows.get(keyOf(row));
            const outcome = result?.outcome ?? 'missing';
            if (required(row) && gating(label)) {
                total++;
                if (outcome === 'pass') passed++; else failed = true;
            }
            if (outcome !== 'pass') failures.push(`- ${cell(label)} / ${cell(keyOf(row))}${required(row) && gating(label) ? ' (required)' : ''}: ${cell(outcome)} — ${cell(result ? reason(result) : 'row absent')}`);
        }
    }
    const lines = [`${failed ? 'FAIL' : 'PASS'}: ${passed}/${total} required checks passed across ${labels.length} runners.`, '',
        `| Item / rendition / variant | ${labels.map(label => cell(label) + (runners.get(label).browser?.name === 'WebKit (not Safari)' || /(?:^|-)webkit(?:-|$)/i.test(label) ? ' — WebKit (not Safari)' : '')).join(' | ')} |`,
        `| --- | ${labels.map(() => '---').join(' | ')} |`];
    for (const row of rows) {
        lines.push(`| ${required(row) ? '**Required** ' : ''}${cell(row.item)} / ${row.rendition} / ${row.variant} | ${labels.map(label => {
            const result = runners.get(label).rows.get(keyOf(row));
            if (!result) return '– missing';
            if (result.outcome === 'pass') return '✓';
            const symbol = ['missing', 'infra'].includes(result.outcome) ? '–' : '✗';
            const detail = reason(result);
            return `${symbol} ${cell(result.outcome)}${detail === result.outcome ? '' : `: ${cell(detail.slice(0, 90))}`}`;
        }).join(' | ')} |`);
    }
    if (failures.length || errors.length) lines.push('', '### Failures', '', ...errors.map(error => `- ${cell(error)}`), ...failures);
    return { markdown: `${lines.join('\n')}\n`, exitCode: failed ? 1 : 0, results };
}

export async function main(argv = process.argv.slice(2)) {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
        expect: { type: 'string', default: '' },
        'gate-all': { type: 'boolean', default: false },
    } });
    gateAll = values['gate-all'];
    const results = [];
    const errors = [];
    for (const file of positionals) {
        try {
            const result = JSON.parse(await readFile(file, 'utf8'));
            const invalid = validate(result);
            if (invalid.length) errors.push(`${file}: ${invalid.join('; ')}`);
            else results.push(result);
        } catch (error) { errors.push(`${file}: ${error.message}`); }
    }
    const report = makeReport(results, { expect: values.expect.split(',').filter(Boolean), errors });
    process.stdout.write(report.markdown);
    return report.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().then(code => { process.exitCode = code; }).catch(error => {
        process.stderr.write(`${error.message}\n`); process.exitCode = 1;
    });
}
