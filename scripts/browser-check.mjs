// Renders the real frontend against fixture agent state and walks the public
// board and the operator deploy flow. No cloud, SSH or identity provider.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWeb } from '../server/web.js';
import { legacyNetwork } from '../agent/fixtures/legacy-network.js';
import { DEFAULT_SETTINGS } from '../shared/settings.js';

const temp = mkdtempSync(join(tmpdir(), 'dash-status-browser-'));
const at = new Date().toISOString();
const container = (name, image, running = true) => ({ name, image, repo: image.split(/[:@]/)[0], running, state: running ? 'running' : 'exited', restarts: 0, startedAt: at, ports: [] });
const system = { load: [0.2, 0.3, 0.3], cpus: 2, memTotal: 4e9, memAvailable: 2e9, uptime: 86400 * 30, disks: [{ mount: '/', size: 5e10, used: 2e10, avail: 3e10 }], os: 'Ubuntu 22.04', kernel: '6.8' };
function state(name, chain, platform) {
  const hosts = [];
  const add = (hostName, role, data, n) => hosts.push({ name: hostName, role, state: 'running', publicIp: `192.0.2.${n}`, privateIp: `10.0.0.${n}`, instanceId: `i-PRIVATE${String(n).padStart(9, '0')}`, instanceType: 't4g.small', arch: 'arm64', az: 'us-west-2a', tagged: true, probe: { ok: true, at, ms: 900, data: { system, ...data } } });
  for (let i = 1; i <= 4; i++) add(`hp-masternode-${i}`, 'validator', {
    core: { chain, blocks: 1000, headers: 1000, chainLockHeight: 1000, subversion: '/Dash Core:23.1.8/', protocol: 70240, connections: 40, synced: true, masternode: { state: 'READY', posePenalty: 0, proTxHash: 'ab'.repeat(32), type: 'Evo' } },
    tenderdash: platform ? { height: 500, network: platform, protocolApp: 13, peers: 30, version: '1.8.1', validatorSetSize: 4, blockTime: at } : null,
    dapi: { ok: true, latencyMs: 25, dapiVersion: '4.2.0-beta.5', driveVersion: '4.2.0-beta.5' },
    containers: [container('dashmate-core-1', 'dashpay/dashd:23'), container('dashmate-drive_abci-1', 'dashpay/drive:4.2.0-beta.5'), container('dashmate-drive_tenderdash-1', 'dashpay/tenderdash:1.8.1'), container('dashmate-rs_dapi-1', 'dashpay/rs-dapi:4.2.0-beta.5'), container('dashmate-gateway-1', 'dashpay/envoy:1.30.2-impr.1'), container('dashmate-dashmate_helper-1', 'dashpay/dashmate-helper:4.2.0-beta.4')],
  }, i);
  for (let i = 1; i <= 2; i++) add(`seed-${i}`, 'seed', { core: { chain, blocks: 1000, connections: 90, connectionsIn: 80 }, tenderdash: { source: 'p2p', peers: 25, network: platform }, containers: [container('dashd', 'dashpay/dashd:23'), container('tenderdash', 'dashpay/tenderdash:1.8.1')] }, 10 + i);
  add('web-1', 'web', { core: { chain, blocks: 1000, subversion: '/Dash Core:23.0.0/' }, insight: { blocks: 1000, syncStatus: 'finished', syncPercentage: 100 }, faucet: { status: 200, latencyMs: 300, title: 'Dash Faucet' }, containers: [container('insight', 'dashpay/insight:4.0.10'), container('faucet', 'dashpay/multifaucet:0.9.2')] }, 20);
  add('wallet-1', 'wallet', { core: { chain, blocks: 1000, wallets: [{ name: 'dashd-wallet-1-faucet', trusted: 147078.24 }, { name: 'dashd-wallet-1-mno', trusted: 298406.03 }] }, containers: [container('dashd', 'dashpay/dashd:22.1.0')] }, 21);
  hosts.push({ name: 'masternode-9', role: 'masternode', state: 'running', publicIp: '192.0.2.40', instanceId: 'i-PRIVATE000000040', tagged: true, probe: { ok: false, at, ms: 12000, error: 'Timed out while waiting for handshake' } });
  return { network: name, generatedAt: at, pollSeconds: 30, discovery: { at }, endpoints: [{ label: 'Insight', url: 'https://insight.testnet.networks.dash.org/insight/', status: 200, ok: true, ms: 40 }], hosts };
}

const dataDir = join(temp, 'data');
mkdirSync(join(dataDir, 'state'), { recursive: true });
writeFileSync(join(dataDir, 'state', 'testnet.json'), JSON.stringify(state('testnet', 'test', 'dash-testnet-51')));
writeFileSync(join(dataDir, 'state', 'devnet-moutai.json'), JSON.stringify(state('devnet-moutai', 'devnet-moutai', 'dash-devnet-moutai')));
const settings = structuredClone(DEFAULT_SETTINGS);
settings.networks.push(structuredClone(legacyNetwork));
settings.operators.push({ id: 42, login: 'fixture-operator', role: 'admin', networks: ['*'] });
writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings));

const fetcher = async (url) => {
  if (url.includes('access_token')) return Response.json({ access_token: 'fixture-token' });
  if (url.includes('api.github.com/users/octocat')) return Response.json({ id: 583231, login: 'octocat', name: 'The Octocat', type: 'User', avatar_url: 'data:,' });
  if (url.includes('hub.docker.com')) return Response.json({ results: [{ name: '4.2.0-beta.5', last_updated: at, images: [{ architecture: 'amd64' }, { architecture: 'arm64' }] }] });
  return Response.json({ id: 42, login: 'fixture-operator' });
};
const origin = 'http://127.0.0.1:4799';
const app = createWeb({ dataDir, origin, auth: { clientId: 'fixture', clientSecret: 'fixture', fetcher }, fetcher });
const server = app.listen(4799, '127.0.0.1');
const browser = await chromium.launch();
mkdirSync('artifacts', { recursive: true });
try {
  for (const [label, viewport] of [['desktop', { width: 1600, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(origin);
    await page.getByText('Core height').first().waitFor();
    assert.ok((await page.locator('body').innerText()).includes('Testnet'));
    await page.screenshot({ path: `artifacts/overview-${label}.png`, fullPage: true });
    await page.goto(origin + '/n/testnet');
    await page.getByText('Seeds · 2').waitFor();
    await page.getByRole('region', { name: 'Functional monitoring' }).waitFor();
    const search = page.getByPlaceholder('filter: name, IP, version, reason…');
    assert.ok((await search.boundingBox()).width >= 160, 'search stays usable on mobile');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'long real endpoint URLs must not widen the document');
    const text = await page.locator('body').innerText();
    assert.ok(text.includes('seed-2') && text.includes('wallet-1') && text.includes('web-1'));
    assert.ok(!text.includes('i-PRIVATE') && !text.includes('10.0.0.'), 'public view must not expose instance IDs or private IPs');
    await page.screenshot({ path: `artifacts/network-${label}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    await page.close();
  }
  // Operator: sign in, prepare an upgrade from the form.
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const start = await page.request.get(origin + '/api/auth/github', { maxRedirects: 0 });
  const state = new URL(start.headers().location).searchParams.get('state');
  await page.goto(`${origin}/api/auth/callback?state=${state}&code=fixture`);
  await page.goto(origin + '/n/devnet-moutai/deploy');
  await page.getByText('Upgrade images').click();
  // Every healthy node starts selected; the unreachable one does not.
  await page.getByText('2 · Nodes · 6 selected').waitFor();
  await page.getByRole('button', { name: 'clear' }).click();
  await page.getByRole('row', { name: /hp-masternode-1/ }).click();
  await page.getByLabel(/^helper/).check();
  await page.getByRole('button', { name: '4.2.0-beta.5' }).click();
  await page.screenshot({ path: 'artifacts/deploy.png', fullPage: true });
  // One click: the upgrade starts as soon as its plan is ready (the default).
  await page.getByRole('button', { name: 'Upgrade now' }).click();
  await page.waitForURL('**/n/devnet-moutai/ops/*');
  const [file] = readdirSync(join(dataDir, 'requests')).filter((f) => f.endsWith('.json'));
  const q = JSON.parse(readFileSync(join(dataDir, 'requests', file), 'utf8'));
  assert.deepEqual([q.action, q.nodes, q.components, q.images, q.options.autoRun], ['upgrade', ['hp-masternode-1'], ['helper'], { helper: 'dashpay/dashmate-helper:4.2.0-beta.5' }, true]);
  rmSync(join(dataDir, 'requests', file));
  // From the network page: newer releases are offered, one click rolls them out.
  await page.goto(origin + '/n/devnet-moutai');
  await page.getByText('updates available').waitFor();
  await page.getByRole('button', { name: 'Upgrade now' }).click();
  await page.waitForURL('**/n/devnet-moutai/ops/*');
  const [one] = readdirSync(join(dataDir, 'requests')).filter((f) => f.endsWith('.json'));
  const u = JSON.parse(readFileSync(join(dataDir, 'requests', one), 'utf8'));
  assert.deepEqual([u.components, u.images, u.options.autoRun, u.nodes.sort()], [['helper'], { helper: 'dashpay/dashmate-helper:4.2.0-beta.5' }, true, ['hp-masternode-1', 'hp-masternode-2', 'hp-masternode-3', 'hp-masternode-4']]);
  rmSync(join(dataDir, 'requests', one));
  // Admin: prepare (non-destructive) a Platform wipe/redeploy of a dashmate devnet.
  await page.goto(origin + '/n/devnet-moutai/reset');
  await page.getByText('Wipe and redeploy Platform').waitFor();
  await page.screenshot({ path: 'artifacts/platform-reset.png', fullPage: true });
  await page.getByRole('button', { name: 'Prepare (non-destructive)' }).click();
  await page.waitForURL('**/n/devnet-moutai/ops/*');
  const reset = readdirSync(join(dataDir, 'requests')).map((f) => JSON.parse(readFileSync(join(dataDir, 'requests', f), 'utf8'))).find((x) => x.action === 'platform-reset');
  assert.deepEqual(reset.images, { drive: 'dashpay/drive:4.2.0-beta.5', dapi: 'dashpay/rs-dapi:4.2.0-beta.5', tenderdash: 'dashpay/tenderdash:1.8.1' });
  assert.equal(reset.options.epochSeconds, 3600);

  // Admin: prepare a new devnet from the form.
  await page.goto(origin + '/devnets/new');
  await page.getByPlaceholder('bonsai').fill('fixture');
  await page.screenshot({ path: 'artifacts/new-devnet.png', fullPage: true });
  await page.getByRole('button', { name: 'Prepare plan for review' }).click();
  await page.waitForURL('**/n/devnet-fixture/ops/*');
  const created = readdirSync(join(dataDir, 'requests')).map((f) => JSON.parse(readFileSync(join(dataDir, 'requests', f), 'utf8'))).find((x) => x.action === 'create-devnet');
  assert.equal(created.network, 'devnet-fixture');
  assert.equal(created.devnet.validators, 13);
  assert.equal(created.devnet.platformEpochSeconds, 3600, 'Platform epochs default to one hour');
  assert.equal(created.devnet.subnetId, undefined, 'placement is never sent by the browser');
  await page.goto(origin + '/settings');
  await page.getByPlaceholder('GitHub login, e.g. octocat').fill('octocat');
  await page.getByRole('button', { name: 'Look up' }).click();
  await page.getByText('The Octocat').waitFor();
  await page.locator('form select').selectOption('viewer');
  await page.locator('form .chip', { hasText: 'devnet-moutai' }).click();
  await page.getByRole('button', { name: 'Add @octocat' }).click();
  // Saved on add, with no page-wide Save: a reload keeps the new account.
  await page.getByText('saved', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Save settings' }).isDisabled(), true, 'adding access leaves nothing unsaved');
  await page.reload();
  await page.getByText('@octocat').waitFor();
  const saved = JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8'));
  assert.deepEqual(saved.operators.find((o) => o.login === 'octocat'), { id: 583231, login: 'octocat', role: 'viewer', networks: ['devnet-moutai'] });
  await page.screenshot({ path: 'artifacts/settings.png', fullPage: true });

  // Infrastructure pages: CI runners (a reporter's push) and the AWS inventory.
  const { id: reporter } = app.ci.addReporter('mac-runner-fixture');
  const hour = (h) => new Date(Date.now() - h * 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z');
  app.ci.ingest(reporter, { v: 1, reporter: '1', python: '3.9.6', at: hour(0),
    host: { hostname: 'fixture.lan', os: 'macOS 26.6.2', arch: 'arm64', cpus: 14, load: [2, 2, 2], memTotal: 38e9, memUsed: 20e9, uptimeSec: 86400, disks: [{ path: '/System/Volumes/Data', total: 5e11, free: 1.2e11 }], docker: null },
    runners: [{ key: '/Users/runner/actions-runner', name: 'mac-runner-fixture', pool: 'platform-repositories', kind: 'native', version: '2.337.0', listening: true, busy: true, job: { name: 'Swift SDK build', start: hour(0.1), repo: 'dashpay/platform', runId: 1, workflow: 'Tests' }, diag: { bytes: 6e9, files: 162880 } }],
    jobs: [3, 5, 9, 30].map((h, i) => ({ runner: '/Users/runner/actions-runner', runnerName: 'mac-runner-fixture', name: 'Swift SDK build', start: hour(h), end: hour(h - 0.1), result: i === 1 ? 'Failed' : 'Succeeded', repo: 'dashpay/platform', runId: 10 + i, attempt: 1, workflow: 'Tests', visibility: 'public' })) });
  // A dash-ci-pool host: a pool of single-use runners, no long-lived ones.
  const { id: poolReporter } = app.ci.addReporter('r730-fixture');
  app.ci.ingest(poolReporter, { v: 1, reporter: '2', python: '3.11.2', at: hour(0),
    host: { hostname: 'proxmox3', os: 'Debian GNU/Linux 12 (bookworm)', arch: 'x86_64', cpus: 88, load: [6, 5, 5], memTotal: 270e9, memUsed: 120e9, uptimeSec: 864000, disks: [{ path: '/', total: 9e11, free: 4e11 }], docker: null },
    runners: [],
    pools: [{ name: 'light', controller: 'r730', backend: 'proxmox-lxc', labels: ['self-hosted', 'Linux', 'X64', 'dash-x64-light'], size: 12, idle: 9, busy: 2, starting: 1, draining: false, at: hour(0),
      instances: [{ name: 'r730-light-0a1b2c', state: 'busy', since: hour(0.01) }, { name: 'r730-light-3d4e5f', state: 'busy', since: hour(0.02) }] }],
    jobs: [0.5, 1, 2, 4, 6, 20].map((h, i) => ({ runner: `r730-light-00000${i}`, runnerName: `r730-light-00000${i}`, pool: 'light', name: i % 2 ? 'Validate PR title' : 'Lint', start: hour(h), end: hour(h - 0.01), result: i === 2 ? 'Failed' : 'Succeeded', repo: 'dashpay/dash', runId: 40 + i, attempt: 1, workflow: 'CI', visibility: 'public' })) });
  mkdirSync(join(dataDir, 'aws'), { recursive: true });
  writeFileSync(join(dataDir, 'aws', 'inventory.json'), JSON.stringify({ at, tookMs: 4000, regions: ['us-west-2'], errors: [],
    instances: [{ region: 'us-west-2', az: 'us-west-2a', id: 'i-0123456789abcdef0', type: 't4g.small', state: 'running', launchTime: at, publicIp: '192.0.2.9', tags: { Name: 'dn-testnet-masternode-1', DashNetwork: 'testnet' }, volumes: ['vol-1'], vcpus: 2, memoryMiB: 2048, lifecycle: 'on-demand' }],
    volumes: [{ region: 'us-west-2', id: 'vol-1', sizeGiB: 50, type: 'gp3', state: 'in-use', attachedTo: 'i-0123456789abcdef0' }, { region: 'us-west-2', id: 'vol-2', sizeGiB: 200, type: 'gp2', state: 'available', attachedTo: null, createTime: at }],
    addresses: [], natGateways: [], loadBalancers: [], lambda: [], dynamodb: [], ecr: [{ region: 'eu-west-1', name: 'rs-dapi', images: 7770, untagged: 5402, bytes: 4.45e11, lastPush: at }], snapshots: [], cloudfront: [], s3: [],
    costs: { at, month: at.slice(0, 7), monthToDate: 3270.85, monthEndEstimate: 3503.4, lastMonth: 3109.17, byService: [{ service: 'EC2 - Other', amount: 1178.9 }, { service: 'Amazon Elastic Compute Cloud - Compute', amount: 897.3 }], daily: [{ day: at.slice(0, 10), amount: 110.2 }] } }));
  for (const [label, viewport] of [['desktop', { width: 1600, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport);
    await page.goto(origin + '/ci');
    await page.getByText('Runner hosts').waitFor();
    const ciPage = await page.locator('body').innerText();
    assert.ok(ciPage.includes('mac-runner-fixture') && ciPage.includes('light pool') && ciPage.includes('r730-light-000000'), 'runners, pools and pool jobs');
    await page.screenshot({ path: `artifacts/ci-${label}.png`, fullPage: true });
    await page.goto(origin + '/aws');
    await page.getByText('Worth a look').waitFor();
    const text = await page.locator('body').innerText();
    assert.ok(text.includes('dn-testnet-masternode-1') && text.includes('Unattached volume') && text.includes('$3,271'));
    await page.screenshot({ path: `artifacts/aws-${label}.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${label}: no horizontal page scroll`);
  }
  // Signed out: the sanitized views, nothing that names or locates a host.
  const anon = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await anon.goto(origin + '/ci');
  await anon.getByText('Public view').waitFor();
  const ciText = await anon.locator('body').innerText();
  assert.ok(ciText.includes('macOS host 1') && ciText.includes('Linux host 1 · light pool') && !ciText.includes('mac-runner-fixture') && !ciText.includes('fixture.lan') && !/r730|proxmox3/.test(ciText), 'public CI anonymised');
  await anon.screenshot({ path: 'artifacts/ci-public.png', fullPage: true });
  await anon.goto(origin + '/aws');
  await anon.getByText('Running instances by network').waitFor();
  const awsText = await anon.locator('body').innerText();
  assert.ok(!awsText.includes('192.0.2.9') && !awsText.includes('dn-testnet-masternode-1') && !awsText.includes('Worth a look'), 'public AWS has totals only');
  await anon.screenshot({ path: 'artifacts/aws-public.png', fullPage: true });

  // Remediation joins monitoring recovery with durable response outcomes.
  // A completed blocked response is never displayed as a successful fix.
  const board = { generatedAt: at, outbox: [], issues: [], delivery: { lastAckAt: at, receiver: { workerAt: Date.parse(at) / 1000, remediation: {
    schemaVersion: 1, generatedAt: at, enabled: true, maxActive: 2, cases: [],
  } } } };
  for (const [id, workerState, outcome, status] of [
    ['working', 'running', null, 'open'], ['queued', 'queued', null, 'open'],
    ['blocked', 'completed', 'blocked', 'open'], ['followup', 'completed', 'blocked', 'resolved'], ['fixed', 'completed', 'resolved', 'resolved'],
    ['verifying', 'completed', 'resolved', 'open'],
  ]) {
    board.issues.push({ id, domain: 'network', scope: 'testnet', target: `private-${id}-host`,
      code: 'host_health', severity: 'warning', status, firstSeen: at, lastSeen: at, resolvedAt: status === 'resolved' ? at : null });
    board.delivery.receiver.remediation.cases.push({ issueId: id, workerState, active: id === 'working',
      pendingEvents: id === 'queued' ? 2 : 0, waitReason: 'resource_conflict',
      lastResponse: outcome ? { outcome, summary: `Private ${id} response`, blocker: id === 'blocked' ? 'Root cause still open' : null,
        nextAction: 'Existing owner retains follow-up', changes: ['Verified supporting-service correction'] } : null });
  }
  const boardFile = join(dataDir, 'incidents', 'state.json');
  writeFileSync(boardFile, JSON.stringify(board));
  const boardErrors = [];
  page.on('pageerror', (error) => boardErrors.push(error.message));
  for (const [label, viewport] of [['desktop', { width: 1600, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport);
    await page.getByRole('link', { name: 'Remediation', exact: true }).click();
    await page.getByText('Autonomous dispatch enabled').waitFor();
    await page.locator('[data-issue-id="blocked"] summary').click();
    await page.getByText('Root cause still open').waitFor();
    assert.ok((await page.locator('[data-issue-id="blocked"]').innerText()).includes('Blocked'));
    assert.ok((await page.locator('[data-issue-id="followup"]').innerText()).includes('Recovered · follow-up'));
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `artifacts/remediation-${label}.png`, fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: remediation fits viewport`);
    await page.getByLabel('Remediation state').selectOption('fixed');
    assert.equal(await page.locator('[data-issue-id]').count(), 1);
    assert.ok(await page.locator('[data-issue-id="fixed"]').count());
    await page.getByLabel('Remediation state').selectOption('followup');
    assert.equal(await page.locator('[data-issue-id]').count(), 1);
    assert.ok(await page.locator('[data-issue-id="followup"]').count());
    await page.getByLabel('Remediation state').selectOption('all');
    await page.getByLabel('Filter remediation issues').fill('private-queued-host');
    assert.equal(await page.locator('[data-issue-id]').count(), 1);
    await page.getByLabel('Filter remediation issues').fill('');
    // Reset details for the next viewport without reloading identity.
    await page.goto(origin + '/aws');
  }
  await anon.goto(origin + '/remediation');
  await anon.getByText('Autonomous dispatch enabled').waitFor();
  const publicBoard = await anon.locator('body').innerText();
  assert.ok(!publicBoard.includes('private-') && !publicBoard.includes('Private blocked response') && !publicBoard.includes('Root cause still open'));
  await anon.screenshot({ path: 'artifacts/remediation-public.png', fullPage: true });
  // Actual server file watcher -> SSE -> client refresh, without navigation.
  board.delivery.receiver.remediation.enabled = false;
  writeFileSync(boardFile, JSON.stringify(board));
  await anon.getByText('New dispatch paused', { exact: true }).waitFor({ timeout: 10_000 });
  board.delivery.receiver.remediation.generatedAt = '2020-01-01T00:00:00Z';
  writeFileSync(boardFile, JSON.stringify(board));
  await anon.getByText('Remediation status is stale or unavailable').waitFor({ timeout: 10_000 });
  assert.deepEqual(boardErrors, []);
  await anon.close();
  console.log(JSON.stringify({ public: 'passed', deployRequest: q.id, settings: 'user added' }));
} finally {
  await browser.close();
  app.close(); server.close();
  rmSync(temp, { recursive: true, force: true });
}
