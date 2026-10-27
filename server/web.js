// Public board + operator console. Holds no cloud or SSH credentials: it reads
// agent state files, writes settings, and queues operation requests for the agent.
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuth } from './auth.js';
import { createCi } from './ci.js';
import { createOrgQueue } from './ci-queue.js';
import { operationMaintenance } from './operation-maintenance.js';
import { loadIncidentState, publicIssues, apiAuthorized, readSecret } from './incidents.js';
import { remediationView } from './remediation.js';
import { publicInventory } from './aws-public.js';
import { COMPONENTS, COMPONENT_REPOS, accessFor, adminFor, loadSettings, memberOf, operatorFor, readJSON, saveSettings, validateSettings, writeAtomic } from '../shared/settings.js';
import { expectations } from '../shared/monitoring.js';
import { evaluateNetwork, projectNetwork } from '../shared/evaluate.js';
import { devnetFiles } from '../shared/devnet-files.js';
import { validateRequest } from '../agent/ops.js';
import { validateMainnetReport } from '../shared/mainnet.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const LIFECYCLE_ACTIONS = ['create-devnet', 'delete-devnet', 'devnet-services', 'devnet-platform', 'platform-reset'];

export function createWeb({ dataDir, origin, auth: authDeps, fetcher = fetch, clock = Date.now, ciGithub = null, ciQueue = {}, mainnetReportToken = process.env.MAINNET_REPORT_TOKEN } = {}) {
  const settingsPath = join(dataDir, 'settings.json');
  const dirs = { state: join(dataDir, 'state'), requests: join(dataDir, 'requests'), ops: join(dataDir, 'ops') };
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  let settings = loadSettings(settingsPath);
  const reloadSettings = () => { settings = loadSettings(settingsPath); return settings; };
  const app = express();
  const auth = createAuth({ origin }, { store: join(dataDir, 'sessions.json'), ...authDeps });
  const clients = new Set();
  const cache = new Map();
  const ci = createCi({ dataDir, fetcher, clock, github: ciGithub, log: (...a) => console.log(new Date(clock()).toISOString(), ...a) });
  const orgQueue = createOrgQueue({ dataDir, fetcher, clock, github: ciGithub, ...ciQueue, log: (...a) => console.log(new Date(clock()).toISOString(), ...a) });
  const awsDir = join(dataDir, 'aws');
  mkdirSync(awsDir, { recursive: true });

  // nginx on the host reaches the container through the Docker bridge gateway.
  app.set('trust proxy', ['loopback', 'uniquelocal']);
  app.use(helmet({ contentSecurityPolicy: { directives: { 'style-src': ["'self'", "'unsafe-inline'"], 'img-src': ["'self'", 'data:', 'https://avatars.githubusercontent.com'] } } }));
  // GitHub org webhook (workflow_job events) for the Actions queue. The HMAC
  // covers the exact bytes GitHub sent, so this reads the raw body. It sits
  // before the /api rate limit: GitHub sends bursts from a few addresses and
  // does not retry, and the signature is the gate.
  app.post('/api/ci/github-webhook', (req, res, next) => (orgQueue.configured() ? next() : res.status(404).json({ error: 'Actions queue webhook is not configured' })),
    express.raw({ type: () => true, limit: '512kb' }), (req, res) => {
    if (!orgQueue.verify(req.body, req.get('x-hub-signature-256'))) return res.status(401).json({ error: 'bad signature' });
    const event = req.get('x-github-event');
    if (event === 'ping') return res.json({ ok: true });
    try {
      const changed = orgQueue.webhook(event, JSON.parse(req.body.toString('utf8')));
      if (changed) pushQueue();
      res.status(changed ? 200 : 202).json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false }));
  app.use('/api/auth/github', rateLimit({ windowMs: 10 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false }));
  app.use(['/api/ops/:id', '/api/ops/:id/*rest'], (req, res, next) => (UUID.test(req.params.id) ? next() : res.status(404).json({ error: 'Operation not found' })));
  // CI reporters authenticate with their own bearer token (no session, no CSRF)
  // and send larger bodies than the console does.
  app.post('/api/ci/report', (req, res, next) => {
    // Authenticate before reading the body.
    req.reporter = ci.authenticate(req.get('authorization'));
    return req.reporter ? next() : res.status(401).json({ error: 'unknown reporter token' });
  }, express.json({ limit: '1mb' }), (req, res) => {
    try {
      const r = ci.ingest(req.reporter, req.body);
      clearTimeout(debounce.get('ci'));
      debounce.set('ci', setTimeout(() => push('ci', { at: new Date(clock()).toISOString() }), 2000));
      res.json(r);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  auth.install(app);

  // The limited Mainnet board is fed by a separately managed observer/fullnode
  // (not the existing mainnet-support fleet). Keep this write path token-only,
  // strictly scoped and public-data-only; it never queues operations.
  app.post('/api/mainnet/report', (req, res) => {
    if (!mainnetReportToken || req.get('authorization') !== `Bearer ${mainnetReportToken}`) return res.status(401).json({ error: 'observer authorization required' });
    try {
      const report = validateMainnetReport(req.body, clock());
      const previous = readJSON(join(dirs.state, 'mainnet.json'));
      if (previous?.generatedAt && Date.parse(report.generatedAt) < Date.parse(previous.generatedAt)) throw new Error('out-of-order report');
      writeAtomic(join(dirs.state, 'mainnet.json'), JSON.stringify(report));
      push('network', { name: 'mainnet', at: report.generatedAt });
      res.status(202).json({ accepted: true, generatedAt: report.generatedAt });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  const user = (req) => auth.session(req)?.user || null;
  const isOperator = (req, network) => operatorFor(settings, user(req), network);
  const isMember = (req, network) => memberOf(settings, user(req), network);
  const isAdmin = (req) => adminFor(settings, user(req));
  const visible = (req) => settings.networks.filter((n) => n.public || isMember(req, n.name));
  const stateOf = (name) => readJSON(join(dirs.state, `${name}.json`));

  function view(network, operator) {
    const state = stateOf(network.name);
    const evaluation = evaluateNetwork(network, state, settings, clock(), readJSON(join(dirs.state, 'image-tags.json'), {}), expectations(listOps(network.name), clock()));
    return projectNetwork(network, evaluation, state, operator);
  }
  function brief(v) {
    const { hosts, ...rest } = v;
    return { ...rest, hostCount: hosts.length, roles: hosts.reduce((a, h) => { if (!h.duplicate) a[h.role] = (a[h.role] || 0) + 1; return a; }, {}),
      problems: hosts.filter((h) => !['ok', 'stopped'].includes(h.level) && !h.duplicate).map((h) => ({ name: h.name, role: h.role, level: h.level, reason: h.reasons.find((r) => r.level === h.level)?.text })) };
  }

  // Additive API: public projection; complete evidence only for admins or the
  // dedicated read-only machine token. A member grant is not account-wide access.
  app.get('/api/issues', (req, res) => {
    reloadSettings();
    const state = loadIncidentState(dataDir);
    const full = isAdmin(req) || apiAuthorized(req.get('authorization'), readSecret(process.env.INCIDENT_API_TOKEN_FILE));
    const maintenance = operationMaintenance(dataDir, settings, clock());
    const body = full && state ? { schemaVersion: 1, generatedAt: state.generatedAt, maintenance, issues: state.issues, sources: state.sources, delivery: { ...state.delivery, pending: state.outbox?.length || 0, quarantined: state.quarantined?.length || 0 } } : publicIssues(state, visible(req).map((n) => n.name));
    const observedAt = Date.parse(state?.generatedAt);
    const stale = !Number.isFinite(observedAt) || clock() - observedAt > 180_000 || observedAt > clock() + 60_000;
    res.status(stale ? 503 : 200).json({ ...body, stale });
  });

  app.get('/api/health', (req, res) => res.json({ service: 'dash-status', status: 'ok' }));
  app.get('/api/remediation', (req, res) => {
    reloadSettings();
    const full = isAdmin(req) || apiAuthorized(req.get('authorization'), readSecret(process.env.INCIDENT_API_TOKEN_FILE));
    res.json(remediationView({ ...loadIncidentState(dataDir), maintenance:operationMaintenance(dataDir, settings, clock()) }, { full, visibleNetworks: visible(req).map((n) => n.name), now: clock() }));
  });
  app.get('/api/me', (req, res) => {
    const u = user(req);
    const a = accessFor(settings, u);
    // allNetworks: access covers every network, including ones created after this
    // session loaded (a devnet being created is not yet in the network list).
    res.json({ user: u, role: a?.role || null, allNetworks: !!a?.networks.includes('*'), operatorOf: u ? settings.networks.filter((n) => isOperator(req, n.name)).map((n) => n.name) : [],
      memberOf: u ? settings.networks.filter((n) => isMember(req, n.name)).map((n) => n.name) : [], admin: isAdmin(req) });
  });
  app.get('/api/overview', (req, res) => {
    reloadSettings();
    res.json({ networks: visible(req).map((n) => brief(view(n, isMember(req, n.name)))), at: new Date(clock()).toISOString() });
  });
  app.get('/api/networks/:name', (req, res) => {
    const n = visible(req).find((x) => x.name === req.params.name);
    if (!n) return res.status(404).json({ error: 'Network not found' });
    res.json(view(n, isMember(req, n.name)));
  });

  // Live updates: agent state rewrites and operation changes are pushed.
  app.get('/api/stream', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const client = { res, req, user: user(req) };
    clients.add(client);
    res.write(`retry: 3000\n\n`);
    const ping = setInterval(() => res.write(`: ping\n\n`), 25_000);
    req.on('close', () => { clearInterval(ping); clients.delete(client); });
  });
  const push = (event, payload, filter = () => true) => {
    const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const c of clients) if (filter(c)) c.res.write(data);
  };
  const debounce = new Map();
  const pushQueue = () => {
    clearTimeout(debounce.get('ci-queue'));
    debounce.set('ci-queue', setTimeout(() => push('ci-queue', { at: new Date(clock()).toISOString() }), 1000));
  };
  function onStateFile(file) {
    const name = file.replace(/\.json$/, '');
    clearTimeout(debounce.get(name));
    debounce.set(name, setTimeout(() => {
      reloadSettings();
      const n = settings.networks.find((x) => x.name === name);
      if (!n) return;
      push('network', { name, at: new Date(clock()).toISOString() }, (c) => n.public || memberOf(settings, c.user, name));
    }, 300));
  }
  function onOpFile(file) {
    if (!file.endsWith('.json')) return; // log growth is streamed separately
    const id = file.replace(/\.json$/, '');
    if (!UUID.test(id)) return;
    clearTimeout(debounce.get(id));
    debounce.set(id, setTimeout(() => {
      const r = readJSON(join(dirs.ops, `${id}.json`));
      if (r) push('op', { id, network: r.network, status: r.status, updatedAt: r.updatedAt }, (c) => memberOf(settings, c.user, r.network));
    }, 250));
  }
  const onAwsFile = (file) => {
    if (file !== 'inventory.json') return;
    clearTimeout(debounce.get('aws'));
    debounce.set('aws', setTimeout(() => push('aws', { at: new Date(clock()).toISOString() }), 500));
  };
  const watchers = [];
  const incidentsDir = join(dataDir, 'incidents');
  mkdirSync(incidentsDir, { recursive: true });
  const onIncidentFile = (file) => {
    if (file !== 'state.json') return;
    clearTimeout(debounce.get('remediation'));
    debounce.set('remediation', setTimeout(() => push('remediation', { at: new Date(clock()).toISOString() }), 300));
  };
  for (const [dir, fn] of [[dirs.state, onStateFile], [dirs.ops, onOpFile], [awsDir, onAwsFile], [incidentsDir, onIncidentFile]]) {
    try { watchers.push(watch(dir, (_, f) => f && !f.endsWith('.tmp') && fn(f))); } catch { /* directory created by the agent later */ }
  }

  // Operator API.
  const requireAccess = (check, message) => (req, res, next) => {
    const s = auth.session(req);
    if (!s) return res.status(401).json({ error: 'Sign in required' });
    req.session = s;
    const network = req.params.name || readJSON(join(dirs.ops, `${req.params.id}.json`))?.network;
    if (!network || !check(settings, s.user, network)) return res.status(403).json({ error: message });
    req.network = network;
    next();
  };
  const requireMember = requireAccess(memberOf, 'Access to this network required');
  const requireOperator = requireAccess(operatorFor, 'Operator access required');
  const opCache = new Map();
  const listOps = (network) => (existsSync(dirs.ops) ? readdirSync(dirs.ops) : []).filter((f) => f.endsWith('.json') && UUID.test(f.slice(0, -5)))
    .map((f) => {
      let mtime; try { mtime = statSync(join(dirs.ops, f)).mtimeMs; } catch { return null; }
      const hit = opCache.get(f);
      if (hit?.mtime === mtime) return hit.r;
      const r = readJSON(join(dirs.ops, f));
      opCache.set(f, { mtime, r });
      return r;
    }).filter((r) => r && (!network || r.network === network))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const request = (payload) => writeAtomic(join(dirs.requests, `${payload.id}${payload.type === 'create' ? '' : '.' + payload.type + '-' + randomUUID().slice(0, 8)}.json`), JSON.stringify(payload));

  app.get('/api/networks/:name/ops', requireMember, (req, res) => res.json({ ops: listOps(req.params.name).slice(0, 100) }));
  // Faucet promo codes of a console devnet: members only, never public.
  app.get('/api/networks/:name/faucet-codes', requireMember, (req, res) => {
    const reg = readJSON(join(dataDir, 'devnets.json'), {})[req.params.name];
    res.json({ codes: reg?.status !== 'deleted' && reg?.promoCodes ? reg.promoCodes : {} });
  });
  const registry = () => readJSON(join(dataDir, 'devnets.json'), {});
  // Connection files of a console devnet, like the legacy dash-network-configs
  // outputs: members only (host addresses, masternode identities).
  app.get('/api/networks/:name/config', requireMember, (req, res) => {
    const n = reloadSettings().networks.find((x) => x.name === req.params.name);
    if (!n || n.kind !== 'dashnet' || !/^devnet-[a-z0-9-]+$/.test(n.name)) return res.status(404).json({ error: 'Connection files exist for console devnets only' });
    const facts = readJSON(join(dataDir, 'devnets', n.name, 'config.json'));
    if (!facts) return res.status(404).json({ error: 'No connection facts yet: they appear once the devnet has a deployment plan' });
    res.json({ facts, files: devnetFiles(facts) });
  });
  app.post('/api/networks/:name/ops', requireOperator, auth.csrf, (req, res) => {
    const n = settings.networks.find((x) => x.name === req.params.name);
    if (!n) return res.status(404).json({ error: 'Network not found' });
    const body = req.body || {};
    if (LIFECYCLE_ACTIONS.includes(body.action) && !isAdmin(req)) return res.status(403).json({ error: 'Only admins manage devnet lifecycle, services and Platform resets' });
    const q = { id: randomUUID(), network: n.name, action: body.action, nodes: body.nodes || [], components: body.components || [], images: body.images || {}, options: body.options || {}, ...(body.confirmName ? { confirmName: body.confirmName } : {}), ...(body.services ? { services: body.services } : {}) };
    try { validateRequest(settings, q, registry()); } catch (e) { return res.status(400).json({ error: e.message }); }
    const busy = listOps(n.name).find((r) => ['queued', 'preparing', 'confirmed', 'running'].includes(r.status));
    if (busy) return res.status(409).json({ error: `operation ${busy.id.slice(0, 8)} (${busy.request.action}) is ${busy.status} on this network`, id: busy.id });
    request({ type: 'create', ...q, actor: req.session.user });
    res.status(202).json({ id: q.id });
  });
  // New devnets (admins; billable). The agent prepares a plan that must be confirmed.
  app.get('/api/devnets/defaults', (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only admins create devnets' });
    res.json({ defaults: reloadSettings().devnets, existing: [...settings.networks.map((n) => n.name), ...Object.keys(registry())] });
  });
  app.post('/api/devnets', (req, res, next) => { const s = auth.session(req); if (!s) return res.status(401).json({ error: 'Sign in required' }); req.session = s; next(); }, auth.csrf, (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only admins create devnets' });
    const body = req.body || {};
    const q = { id: randomUUID(), network: body.name, action: 'create-devnet', nodes: [], devnet: body.devnet || {} };
    try { validateRequest(reloadSettings(), q, registry()); } catch (e) { return res.status(400).json({ error: e.message }); }
    if (listOps(q.network).some((r) => !['failed', 'cancelled', 'rejected', 'succeeded'].includes(r.status))) return res.status(409).json({ error: 'an operation for this name is already active' });
    request({ type: 'create', ...q, actor: req.session.user });
    res.status(202).json({ id: q.id, network: q.network });
  });

  app.get('/api/ops/:id', requireMember, (req, res) => {
    const r = readJSON(join(dirs.ops, `${req.params.id}.json`));
    if (!r) return res.status(404).json({ error: 'Operation not found' });
    res.json({ ...r, log: tail(join(dirs.ops, `${req.params.id}.log`), 256 * 1024) });
  });
  app.get('/api/ops/:id/log', requireMember, (req, res) => {
    const path = join(dirs.ops, `${req.params.id}.log`);
    let offset = Number(req.query.offset);
    if (!Number.isSafeInteger(offset) || offset < 0) offset = 0;
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = () => {
      try {
        if (!existsSync(path)) return;
        const size = statSync(path).size;
        if (size < offset) offset = 0;
        if (size === offset) return;
        const fd = openSync(path, 'r'), buf = Buffer.alloc(Math.min(size - offset, 1 << 20));
        try { readSync(fd, buf, 0, buf.length, offset); } finally { closeSync(fd); }
        offset += buf.length;
        res.write(`event: log\ndata: ${JSON.stringify({ text: buf.toString(), offset })}\n\n`);
      } catch (e) { res.write(`event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`); }
    };
    send();
    const timer = setInterval(send, 1000);
    req.on('close', () => clearInterval(timer));
  });
  for (const type of ['confirm', 'cancel', 'resume']) {
    app.post(`/api/ops/:id/${type}`, requireOperator, auth.csrf, (req, res) => {
      if (!UUID.test(req.params.id)) return res.status(400).json({ error: 'invalid id' });
      const r = readJSON(join(dirs.ops, `${req.params.id}.json`));
      if (type === 'confirm' && (r?.status !== 'review' || req.body?.planId !== r.review?.planId)) return res.status(409).json({ error: 'The plan changed or is not awaiting review' });
      if (LIFECYCLE_ACTIONS.includes(r?.request?.action) && !isAdmin(req)) return res.status(403).json({ error: 'Only admins confirm, cancel or resume devnet lifecycle and Platform resets' });
      request({ type, id: req.params.id, network: req.network, planId: req.body?.planId, actor: req.session.user });
      res.status(202).json({ ok: true });
    });
  }

  // Settings (admins edit everything; any operator may read).
  app.get('/api/settings', (req, res) => {
    if (!memberOf(settings, user(req))) return res.status(403).json({ error: 'Sign in with an account that has access' });
    const s = reloadSettings();
    // Non-admins see only the networks they were granted.
    res.json({ settings: isAdmin(req) ? s : { ...s, networks: s.networks.filter((n) => memberOf(s, user(req), n.name)) }, admin: isAdmin(req) });
  });
  app.put('/api/settings', (req, res, next) => { const s = auth.session(req); if (!s) return res.status(401).json({ error: 'Sign in required' }); req.session = s; next(); }, auth.csrf, (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only admins can change settings' });
    try {
      // Access has its own endpoints; a page-wide save never carries a stale
      // operator list over them.
      const next = validateSettings({ ...req.body?.settings, operators: reloadSettings().operators });
      settings = saveSettings(settingsPath, next);
      push('settings', { at: new Date(clock()).toISOString() });
      res.json({ settings });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // Access changes save immediately (no page-wide Save). Each call edits the
  // current file, never a stale browser copy of the whole settings document.
  const adminWrite = [(req, res, next) => { const s = auth.session(req); if (!s) return res.status(401).json({ error: 'Sign in required' }); req.session = s; next(); }, auth.csrf,
    (req, res, next) => (isAdmin(req) ? next() : res.status(403).json({ error: 'Only admins can change access' }))];
  const changeAccess = (req, res, fn) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) throw new Error('invalid GitHub user id');
      if (id === req.session.user.id) throw new Error('You cannot change your own access');
      const next = structuredClone(reloadSettings());
      fn(next, id);
      settings = saveSettings(settingsPath, validateSettings(next));
      push('settings', { at: new Date(clock()).toISOString() });
      res.json({ operators: settings.operators });
    } catch (e) { res.status(400).json({ error: e.message }); }
  };
  app.put('/api/access/:id', ...adminWrite, (req, res) => changeAccess(req, res, (next, id) => {
    const { login, role, networks } = req.body || {};
    const entry = { id, login: String(login || '').slice(0, 39), role, networks: role === 'admin' ? ['*'] : networks };
    const i = next.operators.findIndex((o) => o.id === id);
    if (i >= 0) next.operators[i] = { ...next.operators[i], ...entry, login: entry.login || next.operators[i].login };
    else next.operators.push(entry);
  }));
  app.delete('/api/access/:id', ...adminWrite, (req, res) => changeAccess(req, res, (next, id) => {
    if (!next.operators.some((o) => o.id === id)) throw new Error('no such account');
    next.operators = next.operators.filter((o) => o.id !== id);
  }));

  // Infrastructure pages: full detail for any account with access; before
  // sign-in a sanitized view (statistics and spend, nothing identifying).
  const publicCache = new Map();
  const cached = (key, fn) => {
    const hit = publicCache.get(key);
    if (hit && clock() - hit.at < 15_000) return hit.value;
    const value = fn();
    publicCache.set(key, { at: clock(), value });
    return value;
  };
  app.get('/api/ci', (req, res) => res.json(memberOf(settings, user(req)) ? ci.summary({ admin: isAdmin(req) }) : cached('ci', () => ci.publicSummary())));
  app.get('/api/ci/queue', (req, res) => res.json(memberOf(settings, user(req)) ? orgQueue.summary({ full: true }) : cached('ci-queue', () => orgQueue.summary())));
  app.post('/api/ci/reporters', ...adminWrite, (req, res) => {
    try {
      const { id, token } = ci.addReporter(req.body?.label);
      res.status(201).json({ id, token, url: `${origin}/api/ci/report` });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.delete('/api/ci/reporters/:id', ...adminWrite, (req, res) => {
    try { ci.removeReporter(req.params.id); res.json({ ok: true }); } catch (e) { res.status(404).json({ error: e.message }); }
  });
  app.get('/api/aws', (req, res) => {
    const inv = readJSON(join(awsDir, 'inventory.json'));
    if (!inv) return res.status(404).json({ error: 'No AWS inventory yet; the agent collects it every 10 minutes' });
    res.json(memberOf(settings, user(req)) ? inv : cached(`aws|${inv.at}`, () => publicInventory(inv)));
  });

  // GitHub account lookup so admins can grant access by login.
  app.get('/api/github/users/:login', async (req, res) => {
    if (!isAdmin(req)) return res.status(403).json({ error: 'Only admins can add users' });
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(req.params.login)) return res.status(400).json({ error: 'Not a valid GitHub login' });
    try {
      const r = await fetcher(`https://api.github.com/users/${req.params.login}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'dash-status' }, signal: AbortSignal.timeout(10_000) });
      if (r.status === 404) return res.status(404).json({ error: `GitHub user ${req.params.login} not found` });
      if (!r.ok) throw new Error(`GitHub ${r.status}`);
      const u = await r.json();
      if (!Number.isSafeInteger(u.id) || typeof u.login !== 'string') throw new Error('Unexpected GitHub response');
      res.json({ id: u.id, login: u.login, name: u.name || null, type: u.type, avatar: u.avatar_url });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // Image tags from Docker Hub for the upgrade form.
  app.get('/api/images/:component/tags', async (req, res) => {
    if (!operatorFor(settings, user(req))) return res.status(403).json({ error: 'Operator access required' });
    const repo = COMPONENT_REPOS[req.params.component];
    if (!repo || !COMPONENTS.includes(req.params.component)) return res.status(404).json({ error: 'Unknown component' });
    const hit = cache.get(repo);
    if (hit && clock() - hit.at < 10 * 60_000) return res.json(hit.value);
    try {
      const r = await fetcher(`https://hub.docker.com/v2/repositories/${repo}/tags?page_size=100&ordering=last_updated`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`Docker Hub ${r.status}`);
      const body = await r.json();
      const value = { repo, tags: (body.results || []).map((t) => ({ name: t.name, updated: t.last_updated, digest: t.digest || null, arches: (t.images || []).map((i) => i.architecture).filter((a) => a && a !== 'unknown') })) };
      cache.set(repo, { at: clock(), value });
      res.json(value);
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown endpoint' }));
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  if (existsSync(dist)) {
    app.use(express.static(dist, { index: false, maxAge: '1h', setHeaders: (res, p) => { if (p.endsWith('.html')) res.set('Cache-Control', 'no-cache'); } }));
    app.get('/{*path}', (req, res) => res.set('Cache-Control', 'no-cache').sendFile('index.html', { root: dist }));
  }
  app.use((error, req, res, next) => { if (res.headersSent) return next(error); res.status([400, 413].includes(error.status) ? error.status : 500).json({ error: error.status === 413 ? 'Request body too large' : 'Request could not be processed' }); });
  app.close = () => { for (const w of watchers) w.close(); for (const c of clients) c.res.end(); orgQueue.flush(); };
  app.ci = ci;
  app.tickQueue = () => orgQueue.tick().then((changed) => { if (changed) pushQueue(); });
  return app;
}

function tail(path, bytes) {
  try {
    const size = statSync(path).size;
    if (size <= bytes) return { text: readFileSync(path, 'utf8'), offset: size, truncated: false };
    const fd = openSync(path, 'r'), buf = Buffer.alloc(bytes);
    readSync(fd, buf, 0, bytes, size - bytes); closeSync(fd);
    return { text: buf.toString().replace(/^[^\n]*\n/, ''), offset: size, truncated: true };
  } catch { return { text: '', offset: 0, truncated: false }; }
}

export function startWeb() {
  const dataDir = process.env.STATUS_DATA_DIR || '/var/lib/dash-status';
  const origin = process.env.PUBLIC_ORIGIN || 'https://status.testnet.networks.dash.org';
  const id = process.env.GITHUB_OAUTH_CLIENT_ID, secret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  // The OAuth app's client credentials raise GitHub's public-API limit to 5000/h.
  // Actions queue: org webhook secret; an optional read-only token (Actions: read on
  // every repository) lets the sweep check private repositories as well.
  const ciQueue = { org: process.env.CI_QUEUE_ORG || 'dashpay', secret: process.env.CI_WEBHOOK_SECRET || null, token: process.env.CI_QUEUE_GITHUB_TOKEN || null };
  const app = createWeb({ dataDir, origin, ciGithub: id && secret ? { id, secret } : null, ciQueue, mainnetReportToken: process.env.MAINNET_REPORT_TOKEN });
  const ciTimer = setInterval(() => { app.ci.tick(); app.tickQueue(); }, 60_000);
  ciTimer.unref();
  const server = app.listen(Number(process.env.PORT) || 3001, process.env.BIND_ADDRESS || '127.0.0.1', () => console.log(`dash-status web on ${process.env.PORT || 3001}`));
  for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { app.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
  return server;
}
