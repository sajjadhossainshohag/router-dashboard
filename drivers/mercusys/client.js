import http from 'node:http';
import https from 'node:https';
import { createHash, createPublicKey, publicEncrypt, createCipheriv, createDecipheriv, randomInt, constants } from 'node:crypto';
import { httpError } from '../../errors.js';

const LOGIN_BACKOFF_MS = 60_000;
const SESSION_ERRORS = new Set(['timeout', 'user conflict', 'permission denied']);

const hexToB64url = hex => Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex').toString('base64url');

export function rsaEncryptHex(text, [nHex, eHex]) {
  const key = createPublicKey({ key: { kty: 'RSA', n: hexToB64url(nHex), e: hexToB64url(eHex) }, format: 'jwk' });
  return publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(text)).toString('hex');
}

const randomDigits = length => Array.from({ length }, () => randomInt(10)).join('');

export function createAes(key = randomDigits(16), iv = randomDigits(16)) {
  const k = Buffer.from(key), i = Buffer.from(iv);
  return {
    key, iv,
    encrypt: text => {
      const c = createCipheriv('aes-128-cbc', k, i);
      return Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('base64');
    },
    decrypt: b64 => {
      const d = createDecipheriv('aes-128-cbc', k, i);
      return Buffer.concat([d.update(b64, 'base64'), d.final()]).toString('utf8');
    },
  };
}

// The router's JS client splits the signature into 53-char pieces, the most PKCS#1 v1.5 fits into a 512-bit key.
export function sign(text, signKey) {
  let out = '';
  for (let pos = 0; pos < text.length; pos += 53) out += rsaEncryptHex(text.slice(pos, pos + 53), signKey);
  return out;
}

export function formEncode(params) {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    for (const item of Array.isArray(v) ? v : [v]) form.append(k, String(item));
  }
  return form.toString();
}

export function createMercusysClient({ url, password, username = 'admin', insecureTls = false, timeout = 10_000 }) {
  const base = new URL(url);
  const lib = base.protocol === 'https:' ? https : http;
  let session = null;
  let loggingIn = null;
  let blockedUntil = 0;
  let blockedReason = '';

  const post = (path, body, cookie) => new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: base.hostname,
      port: base.port || undefined,
      method: 'POST',
      path: `/cgi-bin/luci/${path}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Content-Length': Buffer.byteLength(body),
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${base.origin}/webpages/index.html`,
        ...(cookie && { Cookie: `sysauth=${cookie}` }),
      },
      rejectUnauthorized: !insecureTls,
      timeout,
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('timeout', () => req.destroy(new Error('Router did not respond in time')));
    req.on('error', reject);
    req.end(body);
  });

  const parse = (res, what) => {
    try { return JSON.parse(res.text); } catch {
      throw httpError(502, `Unexpected ${what} response from router (HTTP ${res.status})`);
    }
  };

  async function readPlain(form) {
    const json = parse(await post(`;stok=/login?form=${form}`, 'operation=read'), form);
    if (!json.success && !json.data) throw httpError(502, `Router rejected login?form=${form}`);
    return json.data;
  }

  async function login() {
    if (Date.now() < blockedUntil) throw httpError(503, blockedReason);

    const keys = await readPlain('keys');
    const auth = await readPlain('auth');
    const aes = createAes();
    const hash = createHash('md5').update(username + password).digest('hex');
    const seq = Number(auth.seq);
    const signKey = auth.key;

    const data = aes.encrypt(formEncode({
      operation: 'login',
      password: rsaEncryptHex(password, keys.password),
      confirm: 'true',
    }));
    const body = formEncode({ sign: sign(`k=${aes.key}&i=${aes.iv}&h=${hash}&s=${seq + data.length}`, signKey), data });
    const res = await post(';stok=/login?form=login', body);
    const json = parse(res, 'login');
    const result = json.data && typeof json.data === 'string' ? JSON.parse(aes.decrypt(json.data)) : json;

    if (!result.success || !result.data?.stok) {
      const left = result.data?.attemptsAllowed != null && result.data?.failureCount != null
        ? ` (${result.data.attemptsAllowed - result.data.failureCount} attempts left before lockout)` : '';
      blockedReason = result.errorcode === 'login failed' || result.errorcode === 'exceeded max attempts'
        ? `Router login failed: wrong ROUTER_PASS${left}. Fix .env and restart.`
        : `Router login failed: ${result.errorcode ?? 'unknown error'}`;
      // Retrying a bad password every poll would lock the router's admin login for everyone.
      blockedUntil = result.errorcode === 'login failed' ? Infinity : Date.now() + LOGIN_BACKOFF_MS;
      throw httpError(502, blockedReason);
    }

    const sysauth = /sysauth=([^;]+)/.exec([].concat(res.headers['set-cookie'] ?? []).join(';'))?.[1];
    return { stok: result.data.stok, sysauth, aes, hash, seq, signKey };
  }

  async function ensureSession() {
    if (session) return session;
    loggingIn ??= login().finally(() => { loggingIn = null; });
    session = await loggingIn;
    return session;
  }

  async function send(s, path, params) {
    const data = s.aes.encrypt(formEncode(params));
    const body = formEncode({ sign: sign(`h=${s.hash}&s=${s.seq + data.length}`, s.signKey), data });
    const res = await post(`;stok=${s.stok}/${path}`, body, s.sysauth);
    if (res.status === 401 || res.status === 403) return { expired: true };
    const json = parse(res, path);
    const result = typeof json.data === 'string' ? JSON.parse(s.aes.decrypt(json.data)) : json;
    const code = result.errorcode ?? result.errorCode ?? result.error_code;
    if (result.success === false && SESSION_ERRORS.has(code)) return { expired: true };
    return { result, code };
  }

  return {
    async request(path, params) {
      let s = await ensureSession();
      let reply = await send(s, path, params);
      if (reply.expired) {
        session = null;
        s = await ensureSession();
        reply = await send(s, path, params);
        if (reply.expired) throw httpError(502, 'Router keeps rejecting the session (is someone logged into its web page?)');
      }
      if (reply.result.success === false) throw httpError(502, `Router refused ${path.split('?')[1] ?? path}: ${reply.code ?? 'unknown error'}`);
      return reply.result.data;
    },

    async logout() {
      if (!session) return;
      const s = session;
      session = null;
      await send(s, 'admin/system?form=logout', { operation: 'write' }).catch(() => {});
    },
  };
}
