// Runs the Python reporter against a fixture runner directory and a local
// endpoint: job parsing, worker-log metadata, restarts, delivery and resume.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./dash-ci-reporter.py', import.meta.url));
const GATE = fileURLToPath(new URL('./dash-ci-gate.py', import.meta.url));
const python = spawnSync('python3', ['--version']).status === 0;
const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const fileStamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
const line = (ms, text) => `[${stamp(ms)}Z INFO Terminal] WRITE LINE: ${stamp(ms)}Z: ${text}\n`;

test('reporter parses runner logs, delivers jobs once and resumes from its offsets', { skip: !python && 'python3 not installed' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dcr-'));
  const runner = join(root, 'actions-runner'), diag = join(runner, '_diag'), home = join(root, 'home');
  mkdirSync(diag, { recursive: true }); mkdirSync(home);
  writeFileSync(join(runner, '.runner'), '﻿' + JSON.stringify({ agentName: 'mac-runner-test', poolName: 'platform-repositories', gitHubUrl: 'https://github.com/dashpay' }));
  const t = Date.now() - 3 * 3_600_000;
  // A listener that died mid-job, then the current listener.
  const oldLog = `Runner_${fileStamp(t - 3_600_000)}-utc.log`, log = `Runner_${fileStamp(t)}-utc.log`;
  writeFileSync(join(diag, oldLog), `[${stamp(t - 3_600_000)}Z INFO Listener] Version: 2.336.0\n` + line(t - 3_000_000, 'Running job: Lost job'));
  writeFileSync(join(diag, log), `[${stamp(t)}Z INFO Listener] Version: 2.337.0\n` + line(t + 1000, 'Running job: Swift SDK build / tests (warnings as errors)')
    + line(t + 300_000, 'Job Swift SDK build / tests (warnings as errors) completed with result: Succeeded') + 'partial line without newline');
  writeFileSync(join(diag, `Worker_${fileStamp(t + 2000)}-utc.log`), `{\n  "jobDisplayName": "Swift SDK build / tests (warnings as errors)",\n  "variables": [\n`
    + '{ "k": "ref", "v": "refs/heads/v4.2-dev" }, { "k": "repository", "v": "dashpay/platform" }, { "k": "run_id", "v": "36555705927" }, '
    + '{ "k": "run_attempt", "v": "2" }, { "k": "workflow", "v": "Tests" }, { "k": "head_ref", "v": "" }, { "k": "event_name", "v": "push" }, { "k": "repository_visibility", "v": "public" }\n]}\n');

  const bodies = [];
  const server = createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => { bodies.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.setHeader('content-type', 'application/json'); res.end('{"accepted":1}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/api/ci/report`, token: 'dcr_test_token', runners: [{ dir: runner }] }));
  // Asynchronous: the endpoint above runs on this event loop.
  const run = (...args) => new Promise((resolve) => {
    const p = spawn('python3', [SCRIPT, ...args], { env: { ...process.env, DASH_CI_REPORTER_HOME: home } });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; }); p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  try {
    const dry = await run('--print');
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).jobs.length, 2);
    assert.equal(bodies.length, 0);

    let p = await run();
    assert.equal(p.status, 0, p.stderr);
    const first = bodies.at(-1);
    assert.equal(first.auth, 'Bearer dcr_test_token');
    const r = first.body.runners[0];
    assert.equal(r.name, 'mac-runner-test');
    assert.equal(r.pool, 'platform-repositories');
    assert.equal(r.version, '2.337.0');
    assert.equal(r.listening, false);
    assert.equal(r.diag.files, 3);
    const byName = Object.fromEntries(first.body.jobs.map((j) => [j.name, j]));
    assert.equal(byName['Lost job'].result, 'Abandoned');
    const swift = byName['Swift SDK build / tests (warnings as errors)'];
    assert.equal(swift.result, 'Succeeded');
    assert.equal(swift.repo, 'dashpay/platform');
    assert.equal(swift.runId, 36555705927);
    assert.equal(swift.attempt, 2);
    assert.equal(swift.workflow, 'Tests');
    assert.equal(swift.runnerName, 'mac-runner-test');
    assert.equal(swift.log, undefined);
    assert.ok(first.body.host.cpus > 0 && first.body.host.disks.length > 0);

    // Delivered jobs are not sent again; new lines are picked up from the offset.
    // A job whose worker log is not there yet waits one run for its metadata.
    const recent = Date.now() - 120_000;
    appendFileSync(join(diag, log), '\n' + line(recent, 'Running job: Rust tests') + line(recent + 60_000, 'Job Rust tests completed with result: Failed'));
    p = await run();
    assert.equal(p.status, 0, p.stderr);
    assert.deepEqual(bodies.at(-1).body.jobs, []);
    writeFileSync(join(diag, `Worker_${fileStamp(recent + 1000)}-utc.log`), '{ "jobDisplayName": "Rust tests", "x": [{ "k": "repository", "v": "dashpay/platform" }, { "k": "run_id", "v": "7" }] }\n');
    p = await run();
    assert.equal(p.status, 0, p.stderr);
    assert.deepEqual(bodies.at(-1).body.jobs.map((j) => [j.name, j.result, j.repo, j.runId]), [['Rust tests', 'Failed', 'dashpay/platform', 7]]);

    // The runner starts a new 8 MB page mid-job (no restart): the job completes there.
    appendFileSync(join(diag, log), line(t + 500_000, 'Running job: Long build'));
    const page = `Runner_${fileStamp(t + 600_000)}-utc.log`;
    writeFileSync(join(diag, page), `[${stamp(t + 600_000)}Z WARN GitHubActionsService] GET request to https://broker.actions.githubusercontent.com/message?runnerVersion=2.337.0 has been cancelled.\n` + line(t + 900_000, 'Job Long build completed with result: Succeeded'));
    await run(); p = await run();
    assert.equal(p.status, 0, p.stderr);
    const long = bodies.flatMap((b) => b.body.jobs).filter((j) => j.name === 'Long build');
    assert.deepEqual(long.map((j) => j.result), ['Succeeded']);
    const state = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'));
    assert.deepEqual(state.pending, []);
    assert.deepEqual(state.runners[runner].open, []);
    assert.deepEqual(Object.keys(state.runners[runner].offsets).sort(), [log, page].sort());
    assert.equal(state.runners[runner].after, oldLog);
  } finally { server.close(); }
});

test('reporter sends dash-ci-pool pools and each single-use runner job once', { skip: !python && 'python3 not installed' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dcr-pool-'));
  const pool = join(root, 'run-dash-ci-pool'), home = join(root, 'home');
  mkdirSync(pool); mkdirSync(home);
  const now = Math.floor(Date.now() / 1000);
  const status = (time) => JSON.stringify({ time, host: 'r730', draining: false, runners: 2, busy: 1,
    pools: { light: { size: 12, idle: 1, busy: 1, starting: 0, labels: ['self-hosted', 'Linux', 'X64', 'dash-x64-light'], backend: 'proxmox-lxc' } },
    instances: [{ name: 'r730-light-aaaaaa', pool: 'light', state: 'busy', since: now - 30 }, { name: 'r730-light-bbbbbb', pool: 'light', state: 'idle', since: now - 300 }] });
  writeFileSync(join(pool, 'status.json'), status(now));
  const ledgerJob = (runner, extra = {}) => JSON.stringify({ runner, pool: 'light', name: 'Lint', start: '2026-10-27T19:42:00Z', end: '2026-10-27T19:42:09Z', result: 'Succeeded', repo: 'dashpay/dash', runId: 123, attempt: 1, workflow: 'CI', ...extra }) + '\n';
  writeFileSync(join(pool, 'jobs.jsonl'), ledgerJob('r730-light-cccccc') + 'not json\n' + ledgerJob('r730-light-dddddd', { repo: undefined, result: 'Abandoned', end: null }));

  const bodies = [];
  const server = createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => { bodies.push(JSON.parse(b)); res.setHeader('content-type', 'application/json'); res.end('{}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/api/ci/report`, token: 'dcr_test_token', runners: [], pools: [pool, join(root, 'missing')] }));
  const run = () => new Promise((resolve) => {
    const p = spawn('python3', [SCRIPT], { env: { ...process.env, DASH_CI_REPORTER_HOME: home } });
    let stderr = ''; p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (status) => resolve({ status, stderr }));
  });
  try {
    let p = await run();
    assert.equal(p.status, 0, p.stderr);
    const first = bodies.at(-1);
    assert.equal(first.reporter, '3');
    const [light, missing] = first.pools;
    assert.deepEqual([light.name, light.controller, light.size, light.busy, light.backend, light.error], ['light', 'r730', 12, 1, 'proxmox-lxc', null]);
    assert.deepEqual(light.instances.map((i) => [i.name, i.state]), [['r730-light-aaaaaa', 'busy'], ['r730-light-bbbbbb', 'idle']]);
    assert.match(missing.error, /FileNotFoundError/);
    assert.deepEqual(first.jobs.map((j) => [j.runnerName, j.pool, j.result, j.repo ?? null, j.end ?? null]),
      [['r730-light-cccccc', 'light', 'Succeeded', 'dashpay/dash', '2026-10-27T19:42:09Z'], ['r730-light-dddddd', 'light', 'Abandoned', null, null]]);

    // Already delivered: not sent again; a new ledger line is. A controller that stopped updating is an error.
    appendFileSync(join(pool, 'jobs.jsonl'), ledgerJob('r730-light-eeeeee'));
    writeFileSync(join(pool, 'status.json'), status(now - 600));
    p = await run();
    assert.equal(p.status, 0, p.stderr);
    assert.deepEqual(bodies.at(-1).jobs.map((j) => j.runnerName), ['r730-light-eeeeee']);
    const stale = bodies.at(-1).pools[0];
    assert.match(stale.error, /has not updated its status for 10 min/);
    assert.deepEqual([stale.busy, stale.idle, stale.instances], [0, 0, []]);

    // A ledger longer than the reporter remembers is never replayed.
    writeFileSync(join(pool, 'jobs.jsonl'), Array.from({ length: 6000 }, (_, i) => ledgerJob(`r730-light-${String(i).padStart(6, '0')}`)).join(''));
    writeFileSync(join(pool, 'status.json'), status(Math.floor(Date.now() / 1000)));
    const sent = async () => { let n = 0; for (let i = 0; i < 12; i++) { p = await run(); assert.equal(p.status, 0, p.stderr); n += bodies.at(-1).jobs.length; } return n; };
    assert.equal(await sent(), 2500);
    assert.equal(await sent(), 0);
  } finally { server.close(); }
});

test('gate runs only the reporter commands, only on .runner and _diag', { skip: !python && 'python3 not installed' }, () => {
  const gate = (command, ...args) => spawnSync('python3', [GATE, ...args, '--', 'echo'], { env: { ...process.env, SSH_ORIGINAL_COMMAND: command }, encoding: 'utf8' });
  const docker = ['--dir', '/runner', '--container', 'ci'];
  for (const command of [
    'docker exec ci ls -1A /runner/_diag',
    'docker exec ci stat -c %s /runner/_diag/Runner_20261028-000000-utc.log',
    `docker exec ci sh -c 'tail -c +1 "$1" | head -c 131072' sh /runner/_diag/Worker_20261028-000000-utc.log`,
    `docker exec ci sh -c 'tail -c +4097 "$1"' sh /runner/.runner`,
    `docker exec ci sh -c 'ls -1A "$1" | wc -l' sh /runner/_diag`,
    'docker exec ci test -f /runner/.runner',
    'docker exec ci du -sb /runner/_diag',
    'docker top ci -eo pid,args',
    `docker inspect -f '{{json .State}}|{{.RestartCount}}|{{.Config.Image}}' ci`,
  ]) {
    const p = gate(command, ...docker);
    assert.equal(p.status, 0, `${command}: ${p.stderr}`);
    assert.match(p.stdout, /^docker /);
  }
  for (const command of [
    'docker exec ci cat /runner/.credentials',
    `docker exec ci sh -c 'tail -c +1 "$1"' sh /runner/.credentials`,
    `docker exec ci sh -c 'cat "$1"' sh /runner/.runner`,
    'docker exec ci stat -c %s /runner/_diag/../.credentials',
    'docker exec ci ls -1A /runner/_diag; cat /runner/.credentials',
    'docker exec other ls -1A /runner/_diag',
    'docker run --rm alpine id',
    'ps -A -o command',
    '"unterminated',
    '',
  ]) {
    const p = gate(command, ...docker);
    assert.equal(p.status, 126, command);
    assert.equal(p.stdout, '');
  }
  assert.equal(gate('ps -A -o command', '--dir', '/opt/actions-runner').status, 0);
  assert.equal(gate('docker top ci -eo pid,args', '--dir', '/opt/actions-runner').status, 126);
});

test('reporter reads a runner over SSH through the gate', { skip: (!python && 'python3 not installed') || (process.platform !== 'linux' && 'remote commands need GNU stat/du') }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'dcr-ssh-'));
  const runner = join(root, 'actions-runner'), diag = join(runner, '_diag'), home = join(root, 'home'), bin = join(root, 'bin');
  mkdirSync(diag, { recursive: true }); mkdirSync(home); mkdirSync(bin);
  writeFileSync(join(runner, '.runner'), JSON.stringify({ agentName: 'studio-tart-arm64-1', poolName: 'Default', gitHubUrl: 'https://github.com/dashpay/dash' }));
  writeFileSync(join(runner, '.credentials'), 'secret');
  const t = Date.now() - 3_600_000;
  writeFileSync(join(diag, `Runner_${fileStamp(t)}-utc.log`), `[${stamp(t)}Z INFO Listener] Version: 2.338.0\n` + line(t + 1000, 'Running job: build-depends')
    + line(t + 60_000, 'Job build-depends completed with result: Succeeded'));
  writeFileSync(join(diag, `Worker_${fileStamp(t + 2000)}-utc.log`), '{ "jobDisplayName": "build-depends", "x": [{ "k": "repository", "v": "dashpay/dash" }, { "k": "run_id", "v": "9" }] }\n');
  // ssh: record the options, then hand the remote command line to the gate as sshd would.
  const sshLog = join(root, 'ssh.log');
  writeFileSync(join(bin, 'ssh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${sshLog}'\nfor a; do last=$a; done\nSSH_ORIGINAL_COMMAND=$last exec python3 '${GATE}' --dir '${runner}'\n`);
  chmodSync(join(bin, 'ssh'), 0o755);

  const bodies = [];
  const server = createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => { bodies.push(JSON.parse(b)); res.setHeader('content-type', 'application/json'); res.end('{}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  writeFileSync(join(home, 'config.json'), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/api/ci/report`, token: 'dcr_test_token', runners: [{ ssh: ['ci@vm-host'], dir: runner }] }));
  try {
    const p = await new Promise((resolve) => {
      const c = spawn('python3', [SCRIPT], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, DASH_CI_REPORTER_HOME: home } });
      let stderr = ''; c.stderr.on('data', (d) => { stderr += d; });
      c.on('close', (status) => resolve({ status, stderr }));
    });
    assert.equal(p.status, 0, p.stderr);
    const [r] = bodies.at(-1).runners;
    assert.equal(r.error, undefined);
    assert.deepEqual([r.kind, r.name, r.version, r.listening, r.busy, r.diag.files], ['native', 'studio-tart-arm64-1', '2.338.0', false, false, 2]);
    assert.deepEqual(bodies.at(-1).jobs.map((j) => [j.name, j.result, j.repo, j.runId]), [['build-depends', 'Succeeded', 'dashpay/dash', 9]]);
    const calls = readFileSync(sshLog, 'utf8').trim().split('\n');
    assert.ok(calls.length > 3 && calls.every((c) => c.startsWith('-o BatchMode=yes -o ConnectTimeout=10 ci@vm-host ')), calls.join('\n'));
  } finally { server.close(); }
});
