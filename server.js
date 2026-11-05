import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createMercusysDriver } from './drivers/mercusys/index.js';
import { createAutomation } from './automation.js';
import { createStore } from './store.js';
import { httpError } from './errors.js';

const env = process.env;
const MOCK = process.argv.includes('--mock') || env.MOCK === '1';
const PORT = Number(env.PORT || 3000);
const POLL_MS = Number(env.POLL_MS || 3000);
const MAC_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;

let router;
try {
  router = await createMercusysDriver(env, { mock: MOCK });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const store = createStore(MOCK ? null : env.DATA_FILE || fileURLToPath(new URL('./data/store.json', import.meta.url)));
const automation = createAutomation({ router, store });

let current = null;
let lastError = null;
let chain = Promise.resolve();

async function doRefresh() {
  try {
    let state = await router.loadState();
    if (await automation.tick(state)) state = await router.loadState();
    const devices = [...state.devices].sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
    current = { ...state, devices, mock: MOCK, time: Date.now() };
    lastError = null;
  } catch (err) {
    lastError = err;
    console.error(`Router poll failed: ${err.message}`);
  }
}

const refresh = () => (chain = chain.then(doRefresh));

(async function loop() {
  await refresh();
  setTimeout(loop, POLL_MS);
})();

async function getState() {
  if (!current) await chain;
  if (lastError || !current) throw httpError(502, lastError?.message ?? 'Router not reachable yet');
  return {
    ...current,
    devices: current.devices.map(d => ({ ...d, auto: automation.view(d.mac) })),
    automation: automation.summary(),
  };
}

const deviceName = mac => current?.devices.find(d => d.mac === mac)?.name ?? mac;

async function afterWrite(promise) {
  await promise;
  await refresh();
}

async function manualWrite(mac, kind, write, message) {
  automation.manual(mac, kind);
  await write();
  automation.log('manual', mac, message);
  await refresh();
}

function toBps(mbps) {
  const n = Number(mbps ?? 0);
  if (!Number.isFinite(n) || n < 0 || n > 10000) throw httpError(422, 'Limits must be between 0 and 10000 Mbps');
  return Math.round(n * 1e6);
}

const cleanName = name => {
  const value = String(name ?? '').trim().slice(0, 64);
  if (!value) throw httpError(422, 'Name cannot be empty');
  return value;
};

const safeEqual = (a, b) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

function authorized(req) {
  if (!env.DASH_PASS) return true;
  const [scheme, encoded] = (req.headers.authorization ?? '').split(' ');
  if (scheme !== 'Basic' || !encoded) return false;
  const [user, ...rest] = Buffer.from(encoded, 'base64').toString().split(':');
  return safeEqual(user, env.DASH_USER || 'admin') && safeEqual(rest.join(':'), env.DASH_PASS);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw httpError(413, 'Body too large');
  }
  try { return raw ? JSON.parse(raw) : {}; } catch { throw httpError(400, 'Invalid JSON'); }
}

const send = (res, status, body, type = 'application/json') => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
};

const fmt = bps => bps ? `${bps / 1e6} Mbps` : 'unlimited';

const routes = [
  ['GET', /^\/api\/state$/, () => getState()],
  ['POST', /^\/api\/devices\/([^/]+)\/block$/, (mac, body) => {
    const blocked = Boolean(body.blocked);
    return manualWrite(mac, 'block', () => router.setBlocked(mac, blocked), blocked ? 'Blocked from the dashboard' : 'Unblocked from the dashboard');
  }],
  ['POST', /^\/api\/devices\/([^/]+)\/limit$/, (mac, body) => {
    const limit = { down: toBps(body.down), up: toBps(body.up) };
    return limit.down || limit.up
      ? manualWrite(mac, 'limit', () => router.setLimit(mac, limit), `Speed limit set to ${fmt(limit.down)} down / ${fmt(limit.up)} up`)
      : manualWrite(mac, 'limit', () => router.clearLimit(mac), 'Speed limit removed');
  }],
  ['DELETE', /^\/api\/devices\/([^/]+)\/limit$/, mac => manualWrite(mac, 'limit', () => router.clearLimit(mac), 'Speed limit removed')],
  ['POST', /^\/api\/devices\/([^/]+)\/name$/, async (mac, body) => {
    const name = cleanName(body.name);
    const old = deviceName(mac);
    await afterWrite(router.rename(mac, name));
    if (old !== name) automation.log('manual', mac, `Renamed from "${old}"`);
  }],
  ['PUT', /^\/api\/devices\/([^/]+)\/rules$/, (mac, body) => afterWrite(automation.setRules(mac, body))],
  ['POST', /^\/api\/devices\/([^/]+)\/timer$/, (mac, body) => afterWrite(automation.setTimer(mac, body))],
  ['DELETE', /^\/api\/devices\/([^/]+)\/timer$/, mac => afterWrite(automation.clearTimer(mac))],
  ['PUT', /^\/api\/settings$/, (_, body) => afterWrite(automation.setSettings(body))],
];

http.createServer(async (req, res) => {
  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Router dashboard"' });
    return res.end('Authentication required');
  }

  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return send(res, 200, await readFile(new URL('./public/index.html', import.meta.url)), 'text/html; charset=utf-8');
    }
    for (const [method, pattern, handler] of routes) {
      const match = req.method === method && pathname.match(pattern);
      if (!match) continue;
      const mac = match[1] && decodeURIComponent(match[1]).toUpperCase();
      if (mac !== undefined && !MAC_RE.test(mac)) throw httpError(400, 'Invalid MAC address');
      const body = method === 'GET' ? {} : await readJson(req);
      return send(res, 200, (await handler(mac, body)) ?? { ok: true });
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) {
    send(res, err.status ?? 502, { error: err.message });
  }
}).listen(PORT, () => {
  const target = MOCK ? 'mock router' : env.ROUTER_URL || 'http://192.168.1.1';
  console.log(`Router dashboard on http://localhost:${PORT} -> ${target}`);
});
