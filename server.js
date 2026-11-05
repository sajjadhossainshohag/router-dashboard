import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { createMercusysDriver } from './drivers/mercusys/index.js';
import { httpError } from './errors.js';

const env = process.env;
const MOCK = process.argv.includes('--mock') || env.MOCK === '1';
const PORT = Number(env.PORT || 3000);
const STATE_TTL_MS = Number(env.POLL_MS || 3000);
const MAC_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;

let router;
try {
  router = await createMercusysDriver(env, { mock: MOCK });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

let cached = { at: 0, value: null, pending: null };

function loadState() {
  if (cached.value && Date.now() - cached.at < STATE_TTL_MS) return Promise.resolve(cached.value);
  cached.pending ??= router.loadState()
    .then(state => {
      const devices = [...state.devices].sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
      cached = { at: Date.now(), value: { ...state, devices, mock: MOCK, time: Date.now() }, pending: null };
      return cached.value;
    })
    .finally(() => { cached.pending = null; });
  return cached.pending;
}

const afterWrite = async promise => {
  await promise;
  cached.at = 0;
};

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

const routes = [
  ['GET', /^\/api\/state$/, () => loadState()],
  ['POST', /^\/api\/devices\/([^/]+)\/block$/, (mac, body) => afterWrite(router.setBlocked(mac, Boolean(body.blocked)))],
  ['POST', /^\/api\/devices\/([^/]+)\/limit$/, (mac, body) => {
    const limit = { down: toBps(body.down), up: toBps(body.up) };
    return afterWrite(limit.down || limit.up ? router.setLimit(mac, limit) : router.clearLimit(mac));
  }],
  ['DELETE', /^\/api\/devices\/([^/]+)\/limit$/, mac => afterWrite(router.clearLimit(mac))],
  ['POST', /^\/api\/devices\/([^/]+)\/name$/, (mac, body) => afterWrite(router.rename(mac, cleanName(body.name)))],
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
