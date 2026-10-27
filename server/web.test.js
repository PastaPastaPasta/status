import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWeb } from './web.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';

async function start(userId = 9920871, extraUsers = [], options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'web-'));
  mkdirSync(join(dataDir, 'state'), { recursive: true });
  writeFileSync(join(dataDir, 'state', 'testnet.json'), JSON.stringify({ generatedAt: new Date().toISOString(), hosts: [
    { name: 'seed-2', role: 'seed', state: 'running', publicIp: '192.0.2.2', instanceId: 'i-0eb19958115adb5d0', probe: { ok: true, at: new Date().toISOString(), data: { core: { chain: 'test', blocks: 10 }, containers: [] } } },
  ] }));
  if (extraUsers.length) writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ ...structuredClone(DEFAULT_SETTINGS), operators: [...DEFAULT_SETTINGS.operators, ...extraUsers] }));
  const github = async (url) => url.includes('access_token') ? Response.json({ access_token: 't' })
    : url.includes('/users/octocat') ? Response.json({ id: 583231, login: 'octocat', name: 'The Octocat', type: 'User', avatar_url: 'https://avatars.githubusercontent.com/u/583231' })
      : url.includes('/users/') ? new Response('{}', { status: 404 }) : Response.json({ id: userId, login: 'someone' });
  const origin = 'http://127.0.0.1';
  const app = createWeb({ dataDir, origin, mainnetReportToken: 'fixture-mainnet-token', auth: { clientId: 'c', clientSecret: 's', fetcher: github }, fetcher: github, ...options });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  const req = async (path, opts = {}) => {
    const r = await fetch(base + path, { redirect: 'manual', ...opts, headers: { cookie, origin, ...(opts.headers || {}) } });
    for (const c of r.headers.getSetCookie()) cookie = [cookie, c.split(';')[0]].filter(Boolean).join('; ');
    return r;
  };
  const login = async () => {
    const r = await req('/api/auth/github');
    const state = new URL(r.headers.get('location')).searchParams.get('state');
    await req(`/api/auth/callback?state=${state}&code=x`);
    return (await (await req('/api/session')).json()).csrf;
  };
  return { dataDir, req, login, cookie: () => cookie, close: () => { app.close(); server.close(); } };
}

test('public board needs no session and hides operator fields', async () => {
  const w = await start();
  try {
    const overview = await (await w.req('/api/overview')).json();
    assert.deepEqual(overview.networks.map((n) => n.name), ['testnet', 'mainnet']);
    const n = await (await w.req('/api/networks/testnet')).json();
    assert.equal(n.hosts[0].name, 'seed-2');
    assert.equal(n.hosts[0].instanceId, undefined);
    assert.equal((await w.req('/api/networks/testnet/ops')).status, 401);
  } finally { w.close(); }
});

test('mainnet observer report is token-scoped and appears as limited signals', async () => {
  const w = await start();
  try {
    const body = JSON.stringify({ network: 'mainnet', generatedAt: new Date().toISOString(), probeMs: 42,
      core: { chain: 'main', blocks: 200, headers: 200, chainLockHeight: 200, blockTime: Math.floor(Date.now() / 1000), synced: true },
      platform: { height: 300, blockTime: new Date().toISOString(), network: 'evo1', catchingUp: false },
      quorumServer: { status: 200, latencyMs: 12, quorums: 10, banned: 2, enabled: 100 },
      mainnet: { chainLockAgeSeconds: 4, bigBans: 2, coreStall: false, platformStall: false } });
    assert.equal((await w.req('/api/mainnet/report', { method: 'POST', body, headers: { 'content-type': 'application/json' } })).status, 401);
    const report = await w.req('/api/mainnet/report', { method: 'POST', body, headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-mainnet-token' } });
    assert.equal(report.status, 202);
    const mainnet = await (await w.req('/api/networks/mainnet')).json();
    assert.equal(mainnet.summary.mainnet.platformHeight, 300);
    assert.equal(mainnet.summary.mainnet.bigBans, 2);
    assert.equal(mainnet.hosts[0].mainnet.quorumServer.quorums, 10);
    assert.equal(mainnet.hosts[0].instanceId, undefined);
  } finally { w.close(); }
});

test('operator sign-in queues a validated deployment request; CSRF and non-operators are refused', async () => {
  const w = await start();
  try {
    const csrf = await w.login();
    const n = await (await w.req('/api/networks/testnet')).json();
    assert.equal(n.hosts[0].instanceId, 'i-0eb19958115adb5d0');
    const body = JSON.stringify({ action: 'upgrade', nodes: ['seed-2'], components: ['tenderdash'], images: { tenderdash: 'dashpay/tenderdash:1.8.2' } });
    assert.equal((await w.req('/api/networks/testnet/ops', { method: 'POST', body, headers: { 'content-type': 'application/json' } })).status, 403);
    const bad = await w.req('/api/networks/testnet/ops', { method: 'POST', body: JSON.stringify({ action: 'upgrade', nodes: ['seed-2'], components: ['tenderdash'], images: { tenderdash: 'evil/x:1' } }), headers: { 'content-type': 'application/json', 'x-csrf-token': csrf } });
    assert.equal(bad.status, 400);
    const ok = await w.req('/api/networks/testnet/ops', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-csrf-token': csrf } });
    assert.equal(ok.status, 202);
    const { id } = await ok.json();
    const files = readdirSync(join(w.dataDir, 'requests'));
    assert.deepEqual(files, [`${id}.json`]);
    const q = JSON.parse(readFileSync(join(w.dataDir, 'requests', files[0]), 'utf8'));
    assert.equal(q.type, 'create');
    assert.deepEqual(q.actor, { id: 9920871, login: 'someone' });
    // Settings are editable by full-access operators and validated server-side.
    const { settings } = await (await w.req('/api/settings')).json();
    settings.pollSeconds = 20;
    const saved = await w.req('/api/settings', { method: 'PUT', body: JSON.stringify({ settings }), headers: { 'content-type': 'application/json', 'x-csrf-token': csrf } });
    assert.equal(saved.status, 200);
    // A page-wide save never changes access (it has its own endpoints), so a
    // stale or edited operator list cannot lock admins out or revert a grant.
    settings.operators = [{ id: 1, login: 'x', networks: ['*'] }];
    const stale = await w.req('/api/settings', { method: 'PUT', body: JSON.stringify({ settings }), headers: { 'content-type': 'application/json', 'x-csrf-token': csrf } });
    assert.equal(stale.status, 200);
    assert.ok((await stale.json()).settings.operators.some((o) => o.id === 9920871), 'operators kept from disk');
  } finally { w.close(); }
});

test('signed-in non-operators get the public view only', async () => {
  const w = await start(42);
  try {
    await w.login();
    assert.equal((await w.req('/api/networks/testnet/ops')).status, 403);
    assert.equal((await w.req('/api/settings')).status, 403);
  } finally { w.close(); }
});

test('viewers read granted networks and operations but cannot deploy; admins look up GitHub users', async () => {
  const w = await start(77, [{ id: 77, login: 'viewer', role: 'viewer', networks: ['testnet'] }]);
  try {
    const csrf = await w.login();
    assert.equal((await w.req('/api/networks/testnet/ops')).status, 200);
    const n = await (await w.req('/api/networks/testnet')).json();
    assert.equal(n.hosts[0].instanceId, 'i-0eb19958115adb5d0');
    const post = await w.req('/api/networks/testnet/ops', { method: 'POST', body: JSON.stringify({ action: 'doctor', nodes: ['seed-2'] }), headers: { 'content-type': 'application/json', 'x-csrf-token': csrf } });
    assert.equal(post.status, 403);
    assert.equal((await w.req('/api/github/users/octocat')).status, 403);
    const me = await (await w.req('/api/me')).json();
    assert.equal(me.role, 'viewer');
    assert.deepEqual(me.operatorOf, []);
    assert.equal(me.allNetworks, false);
  } finally { w.close(); }
  const a = await start();
  try {
    await a.login();
    const u = await (await a.req('/api/github/users/octocat')).json();
    assert.deepEqual([u.id, u.login], [583231, 'octocat']);
    assert.equal((await a.req('/api/github/users/nobody-here')).status, 404);
    assert.equal((await a.req('/api/github/users/bad..name')).status, 400);
  } finally { a.close(); }
});

test('sessions survive a web restart', async () => {
  const w = await start();
  let cookie;
  try {
    await w.login();
    const r = await w.req('/api/me');
    const me = await r.json();
    assert.equal(me.role, 'admin');
    assert.equal(me.allNetworks, true, 'wildcard access covers devnets created after the session loaded');
    cookie = w.cookie();
  } finally { w.close(); }
  await new Promise((r) => setTimeout(r, 300));
  const again = createWeb({ dataDir: w.dataDir, origin: 'http://127.0.0.1', auth: { clientId: 'c', clientSecret: 's' } });
  const server = await new Promise((r) => { const s = again.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const me = await (await fetch(`http://127.0.0.1:${server.address().port}/api/me`, { headers: { cookie } })).json();
    assert.equal(me.role, 'admin');
  } finally { again.close(); server.close(); }
});

test('operation ids are validated before touching the filesystem', async () => {
  const w = await start();
  try {
    await w.login();
    assert.equal((await w.req('/api/ops/..%2Fstate%2Ftestnet')).status, 404);
    assert.equal((await w.req('/api/ops/not-a-uuid/log')).status, 404);
  } finally { w.close(); }
});

test('network operators cannot confirm, cancel or resume lifecycle operations', async () => {
  const w = await start(88, [{ id: 88, login: 'op', role: 'operator', networks: ['testnet'] }]);
  try {
    const csrf = await w.login();
    const id = '0b6f3a52-6d0e-4a36-9d7e-6f1c2b3a4d5e';
    mkdirSync(join(w.dataDir, 'ops'), { recursive: true });
    writeFileSync(join(w.dataDir, 'ops', `${id}.json`), JSON.stringify({ id, network: 'testnet', status: 'review', request: { action: 'platform-reset' }, review: { planId: 'p1' }, steps: [] }));
    for (const type of ['confirm', 'cancel', 'resume']) {
      const r = await w.req(`/api/ops/${id}/${type}`, { method: 'POST', body: JSON.stringify({ planId: 'p1' }), headers: { 'content-type': 'application/json', 'x-csrf-token': csrf } });
      assert.equal(r.status, 403, type);
    }
    assert.ok(!readdirSync(join(w.dataDir, 'requests')).length, 'no request reaches the agent');
  } finally { w.close(); }
});

test('faucet promo codes reach network members only', async () => {
  const w = await start(77, [{ id: 77, login: 'viewer', role: 'viewer', networks: ['devnet-bonsai'] }]);
  try {
    writeFileSync(join(w.dataDir, 'devnets.json'), JSON.stringify({ 'devnet-bonsai': { status: 'ready', coreNetwork: 'bonsai-g1', promoCodes: { 'EVONODE-ABCD1234': 4005 } } }));
    assert.equal((await w.req('/api/networks/devnet-bonsai/faucet-codes')).status, 401);
    const pub = JSON.stringify(await (await w.req('/api/overview')).json()) + JSON.stringify(await (await w.req('/api/networks/devnet-bonsai')).json());
    assert.ok(!pub.includes('EVONODE-ABCD1234'), 'codes never in public views');
    await w.login();
    assert.deepEqual((await (await w.req('/api/networks/devnet-bonsai/faucet-codes')).json()).codes, { 'EVONODE-ABCD1234': 4005 });
    assert.equal((await w.req('/api/networks/testnet/faucet-codes')).status, 403);
  } finally { w.close(); }
});

test('access changes save at once and survive a reload; admins cannot lock themselves out', async () => {
  const w = await start();
  try {
    const csrf = await w.login();
    const put = (id, body) => w.req(`/api/access/${id}`, { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-csrf-token': csrf } });
    assert.equal((await put(583231, { login: 'octocat', role: 'admin' })).status, 200);
    const onDisk = JSON.parse(readFileSync(join(w.dataDir, 'settings.json'), 'utf8'));
    assert.deepEqual(onDisk.operators.find((o) => o.id === 583231), { id: 583231, login: 'octocat', role: 'admin', networks: ['*'] });
    assert.ok((await (await w.req('/api/settings')).json()).settings.operators.some((o) => o.id === 583231), 'visible after reload');
    assert.equal((await put(583231, { login: 'octocat', role: 'viewer', networks: ['testnet'] })).status, 200);
    assert.equal((await put(9920871, { login: 'someone', role: 'viewer', networks: ['testnet'] })).status, 400, 'own access is not changeable');
    assert.equal((await w.req('/api/access/583231', { method: 'DELETE', headers: { 'x-csrf-token': csrf } })).status, 200);
    assert.ok(!JSON.parse(readFileSync(join(w.dataDir, 'settings.json'), 'utf8')).operators.some((o) => o.id === 583231));
    assert.equal((await w.req('/api/access/583231', { method: 'PUT', body: '{}', headers: { 'content-type': 'application/json' } })).status, 403, 'CSRF required');
  } finally { w.close(); }
});

test('CI: admins issue reporter tokens; reporters post with them; infrastructure pages need access', async () => {
  const w = await start();
  try {
    // Signed out: the sanitized views.
    assert.equal((await (await w.req('/api/ci')).json()).public, true);
    assert.equal((await w.req('/api/aws')).status, 404, 'no inventory yet');
    const csrf = await w.login();
    const created = await w.req('/api/ci/reporters', { method: 'POST', body: JSON.stringify({ label: 'ubuntu-server-2' }), headers: { 'content-type': 'application/json', 'x-csrf-token': csrf } });
    assert.equal(created.status, 201);
    const { id, token, url } = await created.json();
    assert.equal(url, 'http://127.0.0.1/api/ci/report');
    const body = JSON.stringify({ v: 1, at: '2026-09-29T12:00:00Z', host: { hostname: 'ubuntu-server-2', cpus: 32, load: [0.2, 0.5, 2.4], disks: [] }, runners: [{ key: 'dash-ci-runner', name: 'ubuntu-server-2', kind: 'docker', listening: true, busy: false }],
      jobs: Array.from({ length: 250 }, (_, i) => ({ runner: 'dash-ci-runner', runnerName: 'ubuntu-server-2', name: `job ${i} ${'x'.repeat(200)}`, start: new Date(Date.now() - i * 60_000).toISOString().replace(/\.\d+Z/, 'Z'), result: 'Succeeded' })) });
    const post = (auth) => w.req('/api/ci/report', { method: 'POST', body, headers: { 'content-type': 'application/json', authorization: auth } });
    assert.equal((await post('Bearer dcr_nope_0000000000000')).status, 401);
    const ok = await post(`Bearer ${token}`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { accepted: 250 });
    const huge = JSON.stringify({ v: 1, host: {}, runners: [], pad: 'x'.repeat(1_100_000) });
    assert.equal((await w.req('/api/ci/report', { method: 'POST', body: huge, headers: { 'content-type': 'application/json' } })).status, 401);
    assert.equal((await w.req('/api/ci/report', { method: 'POST', body: huge, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } })).status, 413);
    const s = await (await w.req('/api/ci')).json();
    assert.equal(s.runners[0].name, 'ubuntu-server-2');
    assert.equal(s.reporters[0].id, id);
    assert.equal((await w.req('/api/aws')).status, 404);
    writeFileSync(join(w.dataDir, 'aws', 'inventory.json'), JSON.stringify({ at: 'now', regions: ['us-west-2'], errors: [],
      instances: [{ region: 'us-west-2', id: 'i-0123456789abcdef0', type: 't4g.small', state: 'running', arch: 'arm64', publicIp: '192.0.2.9', tags: { Name: 'dn-testnet-masternode-1', DashNetwork: 'testnet' }, vcpus: 2, memoryMiB: 2048 }],
      volumes: [{ region: 'us-west-2', id: 'vol-1', sizeGiB: 50, type: 'gp3' }], addresses: [{ region: 'us-west-2', publicIp: '192.0.2.9' }], natGateways: [], loadBalancers: [{ region: 'us-west-2', name: 'testnet-alb', type: 'application', dns: 'testnet-alb.elb.amazonaws.com' }],
      lambda: [{ name: 'killdate' }], dynamodb: [], ecr: [{ name: 'rs-dapi', images: 10, bytes: 1e9 }], snapshots: [], cloudfront: [{ aliases: ['quorums.testnet.networks.dash.org'] }], s3: [{ name: 'dash-terraform-state' }],
      costs: { at: 'now', month: '2026-09', monthToDate: 3270.85, monthEndEstimate: 3503.4, lastMonth: 3109.17, byService: [{ service: 'EC2 - Other', amount: 1178.9 }], daily: [] } }));
    assert.equal((await (await w.req('/api/aws')).json()).at, 'now');
    assert.equal((await (await w.req('/api/aws')).json()).instances[0].publicIp, '192.0.2.9', 'members see the inventory');
    assert.equal((await w.req(`/api/ci/reporters/${id}`, { method: 'DELETE', headers: { 'x-csrf-token': csrf } })).status, 200);
    // Signed out: spend and breakdowns, nothing that names or locates a resource.
    await w.req('/api/auth/logout', { method: 'POST', headers: { 'x-csrf-token': csrf } });
    const pub = await (await w.req('/api/aws')).json();
    assert.equal(pub.public, true);
    assert.deepEqual(pub.byNetwork, [{ label: 'testnet', count: 1, vcpus: 2, memoryGiB: 2 }]);
    assert.equal(pub.costs.monthToDate, 3270.85);
    const text = JSON.stringify(pub);
    for (const leak of ['192.0.2.9', 'i-0123456789abcdef0', 'dn-testnet-masternode-1', 'testnet-alb', 'elb.amazonaws', 'killdate', 'rs-dapi', 'quorums.testnet', 'dash-terraform-state', 'vol-1'])
      assert.ok(!text.includes(leak), `leaked ${leak}`);
    assert.equal((await post(`Bearer ${token}`)).status, 401);
  } finally { w.close(); }
});

test('console devnet connection files reach members only', async () => {
  const w = await start();
  try {
    const reg = { 'devnet-fixture': { status: 'ready', displayName: 'Fixture', coreNetwork: 'devnet-fixture-g1' } };
    writeFileSync(join(w.dataDir, 'devnets.json'), JSON.stringify(reg));
    mkdirSync(join(w.dataDir, 'devnets', 'devnet-fixture'), { recursive: true });
    writeFileSync(join(w.dataDir, 'devnets', 'devnet-fixture', 'config.json'), JSON.stringify({ name: 'devnet-fixture', displayName: 'Fixture',
      core: { devnet: 'fixture-g1', chain: 'devnet-fixture-g1', port: 20001, blockSeconds: 10, minimumDifficultyBlocks: 1000000, highSubsidyBlocks: 500, highSubsidyFactor: 100,
        llmq: { chainlocks: 'llmq_devnet', instantsendDip0024: 'llmq_devnet_dip0024', platform: 'llmq_devnet_platform', mnhf: 'llmq_devnet' }, sporkAddress: 'ySpork', seeds: ['198.51.100.1:20001'] },
      platform: { chainId: 'dash-devnet-fixture-g1', initialProtocolVersion: 14, epochSeconds: 3600, quorums: { validatorSet: {}, chainLock: {}, instantLock: {} }, dapi: ['https://198.51.100.1:1443'] },
      services: {}, faucetAddress: null, images: [], hosts: [{ name: 'validators-001', role: 'validator', instanceId: 'i-1', arch: 'arm64', publicIp: '198.51.100.1', privateIp: '10.42.0.1' }] }));
    assert.equal((await w.req('/api/networks/devnet-fixture/config')).status, 401);
    await w.login();
    const r = await (await w.req('/api/networks/devnet-fixture/config')).json();
    assert.deepEqual(r.files.map((f) => f.name), ['devnet-fixture.conf', 'devnet-fixture.inventory', 'devnet-fixture.yml']);
    assert.match(r.files[0].text, /^devnet=fixture-g1$/m);
    assert.equal((await w.req('/api/networks/testnet/config')).status, 404, 'managed networks have no console connection files');
  } finally { w.close(); }
});

test('issue API is additive, fails visibly when stale, and limits private detail to admins', async () => {
  const w = await start();
  try {
    assert.equal((await w.req('/api/issues')).status, 503);
    mkdirSync(join(w.dataDir, 'incidents'), { recursive: true });
    const issues = [{ id: 'a'.repeat(24), domain: 'network', scope: 'testnet', target: 'PRIVATE-HOST', code: 'host_health', severity: 'critical', status: 'open', evidence: { key: 'PRIVATE-EVIDENCE' } },
      { id: 'b'.repeat(24), domain: 'network', scope: 'hidden-network', target: 'PRIVATE', code: 'host_health', severity: 'critical', status: 'open' }];
    writeFileSync(join(w.dataDir, 'incidents', 'state.json'), JSON.stringify({ generatedAt: new Date().toISOString(), issues, sources: {}, outbox: [] }));
    const anonymous = await w.req('/api/issues'); assert.equal(anonymous.status, 200);
    const text = await anonymous.text(); assert.ok(!text.includes('PRIVATE')); assert.ok(!text.includes('hidden-network'));
    const invalid = await w.req('/api/issues', { headers: { authorization: 'Bearer invented' } });
    assert.ok(!(await invalid.text()).includes('PRIVATE'));
    await w.login(); const full = await (await w.req('/api/issues')).json();
    assert.equal(full.issues[0].evidence.key, 'PRIVATE-EVIDENCE'); assert.equal(full.delivery.pending, 0);
  } finally { w.close(); }
});

test('remediation board is read-only and its notes require administrator access', async () => {
  const w = await start();
  try {
    const at = new Date().toISOString();
    writeFileSync(join(w.dataDir, 'incidents', 'state.json'), JSON.stringify({ generatedAt: at, outbox: [],
      issues: [{ id: 'a'.repeat(24), domain: 'network', scope: 'testnet', target: 'PRIVATE-HOST', code: 'host_health', severity: 'critical', status: 'open' }],
      delivery: { receiver: { remediation: { schemaVersion: 1, generatedAt: at, enabled: true, cases: [
        { issueId: 'a'.repeat(24), workerState: 'completed', lastResponse: { outcome: 'blocked', summary: 'PRIVATE-NOTE' } },
      ] } } } }));
    const anonymous = await w.req('/api/remediation'); assert.equal(anonymous.status, 200);
    assert.doesNotMatch(await anonymous.text(), /PRIVATE/);
    const invalid = await w.req('/api/remediation', { headers: { authorization: 'Bearer invented' } });
    assert.doesNotMatch(await invalid.text(), /PRIVATE/);
    await w.login(); const full = await (await w.req('/api/remediation')).json();
    assert.equal(full.public, false); assert.equal(full.cases[0].summary, 'PRIVATE-NOTE');
    assert.equal(full.cases[0].stage, 'blocked');
  } finally { w.close(); }
});

test('Actions queue: signed org webhook in, public and member views out', async () => {
  const w = await start(9920871, [], { ciQueue: { secret: 'hook-secret' } });
  try {
    const send = (event, payload, secret = 'hook-secret') => {
      const body = JSON.stringify(payload);
      return w.req('/api/ci/github-webhook', { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-github-event': event,
        'x-hub-signature-256': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } });
    };
    const job = (id, name, priv) => ({ action: 'queued', organization: { login: 'dashpay' }, repository: { full_name: name, private: priv },
      workflow_job: { id, run_id: id, status: 'queued', name: 'lint', workflow_name: 'CI', labels: ['dash-x64-light'], created_at: new Date().toISOString(), head_branch: 'feat/a' } });
    assert.equal((await send('ping', { zen: 'hi' })).status, 200);
    assert.equal((await send('workflow_job', job(1, 'dashpay/dash', false), 'wrong')).status, 401);
    assert.equal((await send('workflow_job', job(1, 'dashpay/dash', false))).status, 200);
    assert.equal((await send('workflow_job', job(2, 'dashpay/hotfix', true))).status, 200);
    assert.equal((await send('workflow_run', { action: 'requested' })).status, 202);
    const pub = await (await w.req('/api/ci/queue')).json();
    assert.equal(pub.public, true);
    assert.deepEqual(pub.waiting.map((j) => j.repo), ['dashpay/dash']);
    assert.equal(pub.waiting[0].branch, undefined);
    await w.login();
    const full = await (await w.req('/api/ci/queue')).json();
    assert.equal(full.public, false);
    assert.deepEqual(full.waiting.map((j) => j.repo).sort(), ['dashpay/dash', 'dashpay/hotfix']);
  } finally { w.close(); }
});

test('Actions queue webhook is off without a secret', async () => {
  const w = await start();
  try {
    assert.equal((await w.req('/api/ci/github-webhook', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', 'x-github-event': 'ping' } })).status, 404);
    assert.deepEqual((await (await w.req('/api/ci/queue')).json()).configured, { webhook: false, sweep: null });
  } finally { w.close(); }
});
