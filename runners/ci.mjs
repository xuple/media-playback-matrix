// CI orchestration only. Browser gestures and stage measurements belong to the runners.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const columns = [
  ['safari-macos', 'Safari', 'macOS', true],
  ['ios-26.2-iphone', 'Safari', 'iOS 26.2', true],
  ['ios-26.2-ipad', 'Safari', 'iOS 26.2', true],
  ['ios-18.6-iphone', 'Safari', 'iOS 18.6', true],
  ...['macos', 'windows', 'linux'].flatMap(platform =>
    (platform === 'windows' ? ['chrome', 'msedge', 'firefox'] :
      platform === 'macos' ? ['chrome', 'msedge', 'firefox', 'webkit'] :
        ['chrome', 'firefox', 'webkit', 'chromium']).map(browser =>
      [`${platform}-${browser}`, browser === 'webkit' ? 'WebKit (not Safari)' : browser,
        platform, !['webkit', 'chromium'].includes(browser)])),
  ['android-chrome', 'Chrome', 'Android API 34', true],
];
const groups = Object.fromEntries(['macos', 'windows', 'linux'].map(platform =>
  [platform, columns.filter(([label]) => label.startsWith(`${platform}-`))]));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const manifest = () => read('fixtures/manifest.json');
const stamp = () => new Date().toISOString();
function directories() {
  fs.mkdirSync('out', { recursive: true });
  fs.mkdirSync('diagnostics/raw', { recursive: true });
}
function descriptor(label) {
  const known = columns.find(column => column[0] === label.replace(/^spike-/, ''));
  if (!known) throw new Error(`Unknown CI column: ${label}`);
  return [label, ...known.slice(1)];
}
export function absentRows(fixtures, outcome, detail) {
  return fixtures.items.map(item => ({
    item: item.id, rendition: 'playback', variant: 'live', required: true, outcome,
    stages: {}, error: { message: detail }, requests: [],
  }));
}
function infrastructure(label, detail) {
  const [, browser, platform] = descriptor(label);
  const fixtures = manifest();
  return {
    runner: label, browser: { name: browser, version: 'unavailable' },
    os: { name: platform, version: `${os.release()} (host)` },
    device: label.includes('iphone') ? 'iPhone (sim)' : label.includes('ipad') ? 'iPad (sim)' : null,
    started_at: stamp(), finished_at: stamp(), server_commit: null,
    recipe_sha256: fixtures.recipe_sha256 ?? null,
    rows: absentRows(fixtures, 'infra', detail),
  };
}
function save(result) {
  directories();
  fs.writeFileSync(`out/ci-${result.runner}.json`, `${JSON.stringify(result, null, 2)}\n`);
}
function exec(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 20 * 60_000, ...options });
}
function checked(command, args, options = {}) {
  const result = exec(command, args, options);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')}: ${result.error?.message ?? result.stderr ?? result.status}`);
  return result.stdout;
}
function fingerprints() {
  directories();
  return new Map(fs.readdirSync('out').filter(file => file.endsWith('.json')).map(file =>
    [file, createHash('sha256').update(fs.readFileSync(`out/${file}`)).digest('hex')]));
}
function matches(result, browser) {
  const name = result.browser?.name?.toLowerCase() ?? '';
  if (browser === 'msedge') return /edge|msedge/.test(name);
  if (browser === 'chrome') return /chrome/.test(name) && !/chromium/.test(name);
  return name.includes(browser);
}
function run(group, command, args) {
  const expected = groups[group] ?? [descriptor(group)];
  const before = fingerprints();
  const execution = exec(command, args, { stdio: 'inherit' });
  const results = [];
  for (const [file, hash] of fingerprints()) {
    if (before.get(file) === hash || file.startsWith('ci-')) continue;
    try { results.push(read(`out/${file}`)); }
    catch (error) { console.error(`Invalid result ${file}: ${error.message}`); }
    fs.renameSync(`out/${file}`, `diagnostics/raw/${group}-${file}`);
  }
  let failed = execution.status !== 0;
  for (const [label] of expected) {
    const browser = label.split('-').at(-1);
    const candidates = expected.length === 1 ? results : results.filter(result => matches(result, browser));
    let result = candidates.length === 1 ? candidates[0] : null;
    if (!result || !Array.isArray(result.rows) || !result.browser || !result.os) {
      result = infrastructure(label, `Runner produced no unambiguous valid result; exit ${execution.status}: ${execution.error?.message ?? ''}`);
      failed = true;
    } else {
      result = { ...result, source_runner: result.runner, runner: label };
      if (execution.status !== 0) {
        result.runner_error = `Runner exited ${execution.status}: ${execution.error?.message ?? 'see job log'}`;
        // A multi-browser command can fail for another column; retain each column's evidence.
        if (expected.length === 1) {
          result.rows = result.rows.map(row => row.required && row.outcome === 'pass' ?
            { ...row, outcome: 'infra', error: { message: result.runner_error } } : row);
        }
      }
    }
    result = complete(result, manifest());
    if (descriptor(label)[3] && result.rows.some(row => row.required && row.outcome !== 'pass')) failed = true;
    save(result);
  }
  return !failed;
}
export function chooseSimulator(inventory, version, family) {
  const runtime = inventory.runtimes?.find(runtime => runtime.isAvailable &&
    runtime.version === version && /iOS/.test(runtime.identifier));
  if (!runtime) throw new Error(`iOS ${version} runtime unavailable`);
  const device = inventory.devices?.[runtime.identifier]?.find(device =>
    device.isAvailable && device.name.startsWith(family));
  const types = runtime.supportedDeviceTypes ?? inventory.devicetypes ?? [];
  const type = types.find(type => type.name.startsWith(family));
  if (!device && !type) throw new Error(`No ${family} device type for iOS ${version}`);
  return { runtime, device, type };
}
function simulators(spike) {
  let passed = true;
  const attempts = spike ? [null, '/Applications/Xcode_26.2.app/Contents/Developer'] : [null];
  for (const developerDir of attempts) {
    const suffix = spike ? `-${developerDir ? 'xcode26' : 'default'}` : '';
    const env = developerDir ? { ...process.env, DEVELOPER_DIR: developerDir } : process.env;
    for (const [version, family, baseLabel] of [
      ['26.2', 'iPhone', 'ios-26.2-iphone'],
      ...spike ? [] : [['26.2', 'iPad', 'ios-26.2-ipad'], ['18.6', 'iPhone', 'ios-18.6-iphone']],
    ]) {
      const label = `${spike ? 'spike-' : ''}${baseLabel}`;
      let udid;
      try {
        const inventoryText = checked('xcrun', ['simctl', 'list', '--json'], { env });
        fs.writeFileSync(`diagnostics/simctl${suffix}.json`, inventoryText);
        const selected = chooseSimulator(JSON.parse(inventoryText), version, family);
        udid = selected.device?.udid ?? checked('xcrun', ['simctl', 'create', `Audio matrix ${family} ${version}`,
          selected.type.identifier, selected.runtime.identifier], { env }).trim();
        if (selected.device?.state !== 'Booted') checked('xcrun', ['simctl', 'boot', udid], { env });
        checked('xcrun', ['simctl', 'bootstatus', udid, '-b'], { env });
        // safaridriver attaches far more reliably once Simulator.app shows the device and Safari has
        // run once (WebKit bug 205532); otherwise it times out finding a remote Safari.
        exec('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', udid], { env });
        checked('xcrun', ['simctl', 'launch', udid, 'com.apple.mobilesafari'], { env });
        exec('sleep', ['8'], { env });
        // Keep the caller's environment for the child, including the spike's Xcode selection.
        const previous = process.env.DEVELOPER_DIR;
        try {
          if (developerDir) process.env.DEVELOPER_DIR = developerDir;
          if (!run(label, process.execPath, ['runners/safari-webdriver.mjs', '--target', 'simulator', '--udid', udid])) passed = false;
        } finally {
          if (previous === undefined) delete process.env.DEVELOPER_DIR;
          else process.env.DEVELOPER_DIR = previous;
        }
      } catch (error) {
        console.error(error.message);
        save(infrastructure(label, error.message));
        passed = false;
      } finally {
        if (udid) exec('xcrun', ['simctl', 'shutdown', udid], { env });
        if (spike && fs.existsSync(`out/ci-${label}.json`)) {
          fs.copyFileSync(`out/ci-${label}.json`, `diagnostics/simulator-session${suffix}.json`);
        }
      }
    }
  }
  return passed;
}
export function complete(result, fixtures) {
  const rows = [...result.rows];
  for (const item of fixtures.items) {
    const matching = rows.filter(row => row.item === item.id && row.rendition === 'playback' && row.variant === 'live');
    if (matching.length === 0) rows.push(absentRows({ items: [item] }, 'missing', 'Required fixture row absent')[0]);
    else if (matching.length !== 1 || matching[0].required !== true) {
      rows.push(absentRows({ items: [item] }, 'infra', 'Duplicate required row or invalid required flag')[0]);
    }
  }
  return { ...result, rows };
}
function prepare() {
  let valid = true;
  const fixtures = manifest();
  for (const [label] of columns) {
    let result;
    try { result = read(`out/ci-${label}.json`); }
    catch { result = infrastructure(label, 'No artifact from expected CI column'); }
    if (result.runner !== label || !Array.isArray(result.rows)) result = infrastructure(label, 'Invalid column artifact');
    result = complete(result, fixtures);
    save(result);
  }
  for (const file of fs.readdirSync('out').filter(file => file.endsWith('.json'))) {
    if (!columns.some(([label]) => file === `ci-${label}.json`)) {
      console.error(`Unexpected result file: ${file}`);
      valid = false;
    }
  }
  return valid;
}
function merge() {
  const results = columns.map(([label]) => read(`out/ci-${label}.json`));
  const failures = results.flatMap((result, index) => columns[index][3] ?
    result.rows.filter(row => row.required && row.outcome !== 'pass').map(row => `${result.runner}/${row.item}: ${row.outcome}`) : []);
  fs.writeFileSync('merged-results.json', `${JSON.stringify({ results, required_pass: failures.length === 0 }, null, 2)}\n`);
  if (failures.length) console.error(failures.join('\n'));
  return failures.length === 0;
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  directories();
  let success = true;
  if (command === 'wait') {
    success = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const response = await fetch('http://127.0.0.1:8765/manifest.json', { signal: AbortSignal.timeout(1000) });
        if (response.ok && Array.isArray((await response.json()).items)) { success = true; break; }
      } catch { /* The server may still be binding its port. */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!success) console.error('Local audio matrix server did not become ready');
  } else if (command === 'run') {
    const [group, separator, executable, ...runnerArgs] = args;
    if (separator !== '--' || !executable) throw new Error('Usage: ci.mjs run <column|platform> -- <command> <args>');
    success = run(group, executable, runnerArgs);
  } else if (command === 'spike-gate') {
    const files = ['out/ci-spike-safari-macos.json', 'diagnostics/simulator-session-default.json', 'diagnostics/simulator-session-xcode26.json'];
    for (const file of files) {
      const result = complete(read(file), manifest());
      if (result.rows.some(row => row.required && row.outcome !== 'pass')) success = false;
    }
  } else if (command === 'infra') save(infrastructure(args[0], args.slice(1).join(' ')));
  else if (command === 'simulators') success = simulators(args.includes('--spike'));
  else if (command === 'prepare') success = prepare();
  else if (command === 'merge') success = merge();
  else throw new Error(`Unknown CI command: ${command}`);
  if (!success) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
