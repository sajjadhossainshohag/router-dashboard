import http from 'node:http';
import { generateKeyPairSync, createHash, randomBytes } from 'node:crypto';
import { createAes } from './client.js';

const FAKE_PASSWORD = 'mock-password';

function rsaKey(bits) {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  const jwk = privateKey.export({ format: 'jwk' });
  const big = b64 => BigInt(`0x${Buffer.from(b64, 'base64url').toString('hex')}`);
  return { n: big(jwk.n), e: big(jwk.e), d: big(jwk.d), bytes: bits / 8 };
}

const hex = n => n.toString(16);

function modPow(base, exp, mod) {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = result * base % mod;
    base = base * base % mod;
    exp >>= 1n;
  }
  return result;
}

// Node refuses PKCS#1 v1.5 private decryption (Marvin attack mitigation), so the fake router does raw RSA itself.
function rsaDecrypt(key, cipherHex) {
  const blockHex = key.bytes * 2;
  let out = '';
  for (let pos = 0; pos < cipherHex.length; pos += blockHex) {
    const m = modPow(BigInt(`0x${cipherHex.slice(pos, pos + blockHex)}`), key.d, key.n);
    const block = Buffer.from(m.toString(16).padStart(blockHex, '0'), 'hex');
    if (block[0] !== 0 || block[1] !== 2) throw new Error('bad PKCS#1 padding');
    out += block.subarray(block.indexOf(0, 2) + 1).toString('utf8');
  }
  return out;
}

const devices = [
  ['A4-83-E7-1B-22-01', '192.168.1.100', 'Johns-iPhone', '5G', -52],
  ['3C-22-FB-90-11-AE', '192.168.1.101', 'MacBook-Pro', '5G', -61],
  ['00-1A-79-44-5C-02', '192.168.1.102', 'LivingRoom-TV', 'wired', null],
  ['F0-9F-C2-33-7A-44', '192.168.1.103', 'Galaxy-S24', '2.4G', -70],
  ['70-EE-50-12-AB-55', '192.168.1.104', 'Netatmo', '2.4G', -78],
  ['DC-A6-32-8E-4F-66', '192.168.1.105', 'Desktop-PC', 'wired', null],
  ['8C-85-90-AA-01-77', '192.168.1.106', 'iPad', '5G', -66],
];

function createState() {
  const clients = devices.map(([mac, ip, name, tag, signal]) => ({
    mac, ip, deviceName: name, deviceType: 'other', deviceTag: tag, signal: signal == null ? '' : String(signal),
    enableLimit: 'off', uploadLimit: -1, downloadLimit: -1, onlineTime: 3600, isGuest: false,
    demand: { down: 0, up: 0 },
  }));
  const tick = () => {
    for (const c of clients) {
      const peak = /TV|Desktop|MacBook/.test(c.deviceName) ? 10e6 : 2e6;
      c.demand.down = Math.max(0, c.demand.down * 0.6 + Math.random() * peak * 0.4 * (Math.random() < 0.3 ? 2 : 0.5));
      c.demand.up = c.demand.down * (0.05 + Math.random() * 0.15);
    }
  };
  setInterval(tick, 1000).unref();
  return { clients, blacklist: [], access: { enable: 'off', access_mode: 'black' } };
}

function handle(state, path, p) {
  const { clients, blacklist, access } = state;
  const byMac = mac => clients.find(c => c.mac === mac);
  const cap = (bytes, kbps) => Number(kbps) > 0 ? Math.min(bytes, Number(kbps) * 1000 / 8) : bytes;

  switch (`${path}#${p.operation}`) {
    case 'admin/status?form=all#read':
      return { cpu_usage: 0.08 + Math.random() * 0.2, mem_usage: 0.45 + Math.random() * 0.05 };
    case 'admin/firmware?form=upgrade#read':
      return { model: 'MR60X', hardware_version: 'MR60X v2.20', firmware_version: '1.1.4 Build 20250929 rel.40000(5553)' };
    case 'admin/smart_network?form=game_accelerator#loadDevice':
      return clients.filter(c => !blacklist.some(b => b.mac === c.mac)).map(({ demand, ...c }) => {
        const limited = c.enableLimit === 'on';
        return {
          ...c,
          downloadSpeed: Math.round(limited ? cap(demand.down, c.downloadLimit) : demand.down),
          uploadSpeed: Math.round(limited ? cap(demand.up, c.uploadLimit) : demand.up),
        };
      });
    case 'admin/smart_network?form=client_speed_limit#read_max':
      return { isSupportSpeedLimit: 'yes', uploadLimitMax: 1000000, downloadLimitMax: 1000000, max_dev: 32 };
    case 'admin/smart_network?form=client_speed_limit#write': {
      const c = byMac(p.mac);
      if (!c) throw new Error('no such client');
      Object.assign(c, { enableLimit: p.enableLimit, uploadLimit: Number(p.uploadLimit), downloadLimit: Number(p.downloadLimit) });
      return {};
    }
    case 'admin/traffic?form=dev_name#write':
      byMac(p.mac).deviceName = p.alias;
      return {};
    case 'admin/access_control?form=enable#read': return { enable: access.enable };
    case 'admin/access_control?form=enable#write': access.enable = p.enable; return {};
    case 'admin/access_control?form=mode#read': return { access_mode: access.access_mode };
    case 'admin/access_control?form=mode#write': access.access_mode = p.access_mode; return {};
    case 'admin/access_control?form=black_list#load': return blacklist;
    case 'admin/access_control?form=black_list#insert': {
      const entry = JSON.parse(p.new);
      blacklist.push({ ...entry, key: `key-${randomBytes(3).toString('hex')}`, host: 'NON_HOST' });
      return {};
    }
    case 'admin/access_control?form=black_list#remove': {
      const i = blacklist.findIndex(b => b.key === p.key);
      if (i < 0 || String(i) !== String(p.index)) throw new Error('key/index mismatch');
      blacklist.splice(i, 1);
      return {};
    }
    case 'admin/system?form=logout#write': return {};
  }
  throw new Error(`fake router: no handler for ${path} operation=${p.operation}`);
}

export function startFakeMercusys({ port = 0, password = FAKE_PASSWORD } = {}) {
  const pwdKey = rsaKey(1024);
  const signKey = rsaKey(512);
  const seq = 400000 + Math.floor(Math.random() * 1000);
  const state = createState();
  const sessions = new Map();

  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = Object.fromEntries(new URLSearchParams(raw));
    const reply = (obj, headers = {}) => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(obj));
    };
    const match = /^\/cgi-bin\/luci\/;stok=([^/]*)\/(.+)$/.exec(req.url);
    if (!match) { res.writeHead(404); return res.end(); }
    const [, stok, path] = match;

    try {
      if (path === 'login?form=keys') return reply({ success: true, data: { password: [hex(pwdKey.n), hex(pwdKey.e)] } });
      if (path === 'login?form=auth') return reply({ success: true, data: { key: [hex(signKey.n), hex(signKey.e)], seq } });

      const signed = Object.fromEntries(new URLSearchParams(rsaDecrypt(signKey, body.sign)));
      const expectedHash = createHash('md5').update('admin' + password).digest('hex');
      if (Number(signed.s) !== seq + body.data.length) throw new Error('bad signature sequence');

      if (path === 'login?form=login') {
        const aes = createAes(signed.k, signed.i);
        const p = Object.fromEntries(new URLSearchParams(aes.decrypt(body.data)));
        if (signed.h !== expectedHash || rsaDecrypt(pwdKey, p.password) !== password) {
          return reply({ data: aes.encrypt(JSON.stringify({ success: false, errorcode: 'login failed', data: { failureCount: 1, attemptsAllowed: 10 } })) });
        }
        const newStok = randomBytes(16).toString('hex');
        const sysauth = randomBytes(16).toString('hex');
        sessions.clear();
        sessions.set(newStok, { aes, sysauth });
        return reply({ data: aes.encrypt(JSON.stringify({ success: true, data: { stok: newStok } })) },
          { 'Set-Cookie': `sysauth=${sysauth}; path=/cgi-bin/luci/` });
      }

      const s = sessions.get(stok);
      if (!s || !req.headers.cookie?.includes(`sysauth=${s.sysauth}`)) {
        res.writeHead(403); return res.end();
      }
      if (signed.h !== expectedHash) throw new Error('bad signature hash');
      const params = Object.fromEntries(new URLSearchParams(s.aes.decrypt(body.data)));
      let result;
      try {
        result = { success: true, data: handle(state, path, params) };
      } catch (err) {
        result = { success: false, errorcode: err.message };
      }
      reply({ data: s.aes.encrypt(JSON.stringify(result)) });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(err.message);
    }
  });

  return new Promise(resolve => server.listen(port, '127.0.0.1', () => {
    server.unref();
    resolve({ url: `http://127.0.0.1:${server.address().port}`, password, server });
  }));
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  const port = Number(process.argv[2] || 8099);
  startFakeMercusys({ port }).then(({ url, server }) => {
    server.ref();
    console.log(`Fake MR60X on ${url} (password: ${FAKE_PASSWORD})`);
  });
}
