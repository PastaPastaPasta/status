import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

// ---- session / API -------------------------------------------------------
let session = { user: null, csrf: null, loginAvailable: false, loaded: false };
const sessionSubs = new Set();
export async function loadSession() {
  const [s, me] = await Promise.all([
    fetch('/api/session', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({})),
    fetch('/api/me', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({})),
  ]);
  session = { ...s, operatorOf: me.operatorOf || [], memberOf: me.memberOf || [], allNetworks: !!me.allNetworks, role: me.role || null, admin: !!me.admin, loaded: true };
  sessionSubs.forEach((f) => f());
}
export { canOperate, canSee } from './access.js';
export function useSession() {
  return useSyncExternalStore((f) => { sessionSubs.add(f); return () => sessionSubs.delete(f); }, () => session);
}
export async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, {
    method, cache: 'no-store',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-csrf-token': session.csrf || '' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `HTTP ${r.status}`), { status: r.status, data });
  return data;
}
export async function logout() {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  await loadSession();
}

// ---- live updates --------------------------------------------------------
const listeners = new Set();
let source;
// EventSource gives up for good after a non-200 reconnect (e.g. a 502 while the
// web container restarts); recreate it with backoff and resync everything.
let backoff = 1000;
function ensureStream() {
  if (source) return;
  source = new EventSource('/api/stream');
  for (const type of ['network', 'op', 'settings', 'ci', 'ci-queue', 'aws', 'remediation']) source.addEventListener(type, (e) => {
    const data = JSON.parse(e.data);
    listeners.forEach((l) => l(type, data));
  });
  source.onopen = () => {
    if (backoff > 1000) listeners.forEach((l) => { l('network', { name: '*' }); l('op', { id: '*' }); l('ci', {}); l('ci-queue', {}); l('aws', {}); });
    backoff = 1000;
  };
  source.onerror = () => {
    if (source.readyState !== EventSource.CLOSED) return;
    source = null;
    setTimeout(ensureStream, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  };
}
export function useStream(fn) {
  const ref = useRef(fn);
  useEffect(() => { ref.current = fn; });
  useEffect(() => {
    ensureStream();
    const l = (t, d) => ref.current(t, d);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
}

// Fetch a resource and refetch when the stream says it changed.
export function useResource(path, match) {
  // State is keyed by path so a new path never shows the previous resource.
  const [state, setState] = useState({ path: null, data: null, error: null });
  const reload = useCallback(() => {
    if (!path) return;
    api(path).then((data) => setState({ path, data, error: null }), (error) => setState((s) => ({ ...s, path, error })));
  }, [path]);
  useEffect(() => { reload(); }, [reload]);
  const timer = useRef(null);
  useStream((type, data) => {
    if (!match || !match(type, data)) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(reload, 150);
  });
  const current = state.path === path;
  return { data: current ? state.data : null, error: current ? state.error : null, loading: !current, reload };
}

// ---- routing -------------------------------------------------------------
const routeSubs = new Set();
// A page with unsaved edits registers a guard; in-app navigation (links and
// the browser's back/forward) then asks before leaving it.
let leaveGuard = null;
export function setLeaveGuard(message) { leaveGuard = message; }
const mayLeave = () => !leaveGuard || window.confirm(leaveGuard);
export function navigate(to) {
  if (to === location.pathname + location.search) return;
  if (!mayLeave()) return;
  leaveGuard = null;
  history.pushState({}, '', to);
  routeSubs.forEach((f) => f());
  window.scrollTo(0, 0);
}
let current = location.pathname + location.search;
window.addEventListener('popstate', () => {
  if (leaveGuard && !mayLeave()) { history.pushState({}, '', current); return; }
  leaveGuard = null;
  current = location.pathname + location.search;
  routeSubs.forEach((f) => f());
});
routeSubs.add(() => { current = location.pathname + location.search; });
export function useRoute() {
  return useSyncExternalStore((f) => { routeSubs.add(f); return () => routeSubs.delete(f); }, () => location.pathname + location.search);
}
export function linkProps(to) {
  return { href: to, onClick: (e) => { if (e.metaKey || e.ctrlKey || e.button) return; e.preventDefault(); navigate(to); } };
}

// ---- time ----------------------------------------------------------------
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]);
  return now;
}
export function ago(ts, now = Date.now()) {
  if (ts == null) return '—';
  const s = Math.max(0, Math.round((now - (typeof ts === 'number' ? ts : Date.parse(ts))) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}
export function duration(sec) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
// 3600 -> "1 h", 600 -> "10 min", 90 -> "90 s"
export function span(sec) {
  if (sec == null) return '—';
  if (sec % 86400 === 0) return `${sec / 86400} d`;
  if (sec % 3600 === 0) return `${sec / 3600} h`;
  if (sec % 60 === 0) return `${sec / 60} min`;
  return `${sec} s`;
}
// Job and queue times: 45s, 12m 05s, 3h 07m.
export function secs(s) {
  if (s == null) return '—';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}
export function clock(ts) {
  if (!ts) return '—';
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

// ---- numbers -------------------------------------------------------------
export const num = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US'));
export function bytes(v) {
  if (v == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, x = v;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(x >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}
export const pct = (v) => (v == null ? '—' : `${Math.round(v)}%`);
export const dash = (v) => (v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }));
export const short = (h, n = 8) => (h ? `${h.slice(0, n)}…` : '—');

export const LEVEL_LABEL = { ok: 'ok', warn: 'warn', down: 'down', unreachable: 'unreachable', stopped: 'stopped', info: 'info', deploying: 'deploying' };
export const ROLE_LABEL = { validator: 'Evo masternodes', masternode: 'Regular masternodes', seed: 'Seeds', fullnode: 'Full nodes', web: 'Web', wallet: 'Wallet / services', miner: 'Miners', mixer: 'Mixers', quorums: 'Quorum list', metrics: 'Metrics', logs: 'Logs', vpn: 'VPN', other: 'Other' };
