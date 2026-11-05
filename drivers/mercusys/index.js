import { createMercusysClient } from './client.js';
import { startFakeMercusys } from './fake-router.js';
import { httpError, optional } from '../../errors.js';

const STATUS_TTL_MS = 10_000;
const toMac = mac => String(mac).toUpperCase().replace(/-/g, ':');
const routerMac = mac => mac.replace(/:/g, '-');
const truthy = v => v === true || ['on', 'yes', 'true', '1'].includes(String(v).toLowerCase());
const kbpsToBps = kbps => Number(kbps) > 0 ? Number(kbps) * 1000 : 0;
const bpsToKbps = bps => bps > 0 ? Math.max(1, Math.round(bps / 1000)) : -1;
const list = data => Array.isArray(data) ? data : [];

export async function createMercusysDriver(env, { mock }) {
  let url = env.ROUTER_URL || 'http://192.168.1.1';
  let password = env.ROUTER_PASS;
  if (mock) ({ url, password } = await startFakeMercusys());
  if (!password) throw new Error('Set ROUTER_PASS (the MR60X web login password) in .env.');

  const client = createMercusysClient({
    url,
    password,
    insecureTls: env.ROUTER_INSECURE_TLS === '1',
  });

  let support;
  let firmware;
  let status = { at: 0, data: null };

  async function speedLimitSupport() {
    if (support !== undefined) return support;
    const max = await optional(client.request('admin/smart_network?form=client_speed_limit', { operation: 'read_max' }));
    support = max && truthy(max.isSupportSpeedLimit ?? 'yes') ? {
      down: kbpsToBps(max.downloadLimitMax ?? max.downloadMax) || null,
      up: kbpsToBps(max.uploadLimitMax ?? max.uploadMax) || null,
    } : null;
    return support;
  }

  async function routerStatus() {
    if (Date.now() - status.at < STATUS_TTL_MS) return status.data;
    status = { at: Date.now(), data: await optional(client.request('admin/status?form=all', { operation: 'read' })) };
    return status.data;
  }

  const loadBlacklist = async () => list(await client.request('admin/access_control?form=black_list', { operation: 'load' }));

  async function loadDevices() {
    const [clients, blacklist] = await Promise.all([
      client.request('admin/smart_network?form=game_accelerator', { operation: 'loadDevice' }),
      loadBlacklist(),
    ]);
    const blocked = new Map(blacklist.map(b => [toMac(b.mac), b]));
    const devices = new Map();

    for (const c of list(clients)) {
      const mac = toMac(c.mac);
      const ip = c.ip && c.ip !== '0.0.0.0' ? c.ip : null;
      const tag = String(c.deviceTag ?? '');
      const wired = /wired|lan|eth/i.test(tag);
      const limited = truthy(c.enableLimit);
      devices.set(mac, {
        mac,
        ip,
        name: c.deviceName || c.name || mac,
        hostName: c.deviceName ?? null,
        canRename: true,
        online: Boolean(ip) && !/offline/i.test(tag),
        connection: wired ? 'wired' : 'wifi',
        interface: wired ? null : `${tag}${truthy(c.isGuest) ? ' guest' : ''}` || null,
        signal: !wired && c.signal && Number(c.signal) < 0 ? Number(c.signal) : null,
        blocked: blocked.has(mac),
        limit: limited ? { down: kbpsToBps(c.downloadLimit), up: kbpsToBps(c.uploadLimit) } : null,
        rate: { down: Number(c.downloadSpeed ?? 0) * 8, up: Number(c.uploadSpeed ?? 0) * 8 },
        raw: c,
      });
    }
    for (const [mac, b] of blocked) {
      if (devices.has(mac)) continue;
      devices.set(mac, {
        mac, ip: null, name: b.name || mac, hostName: null, canRename: false, online: false,
        connection: 'wifi', interface: null, signal: null, blocked: true, limit: null, rate: null,
      });
    }
    return [...devices.values()];
  }

  async function findDevice(mac) {
    const device = (await loadDevices()).find(d => d.mac === mac);
    if (!device) throw httpError(404, 'Device not found');
    return device;
  }

  async function ensureBlacklistMode() {
    const [enable, mode] = await Promise.all([
      client.request('admin/access_control?form=enable', { operation: 'read' }),
      client.request('admin/access_control?form=mode', { operation: 'read' }),
    ]);
    const on = truthy(enable?.enable);
    if (mode?.access_mode === 'white' && on) {
      throw httpError(409, 'Access Control on the router is in whitelist mode; switch it to blacklist in Security > Access Control first');
    }
    if (!on) await client.request('admin/access_control?form=enable', { operation: 'write', enable: 'on' });
    if (mode?.access_mode !== 'black') await client.request('admin/access_control?form=mode', { operation: 'write', access_mode: 'black' });
  }

  async function writeLimit(device, enable, down, up) {
    await client.request('admin/smart_network?form=client_speed_limit', {
      operation: 'write',
      mac: device.raw?.mac ?? routerMac(device.mac),
      enableLimit: enable ? 'on' : 'off',
      downloadLimit: down,
      uploadLimit: up,
    });
  }

  process.once('SIGINT', () => client.logout().finally(() => process.exit(0)));
  process.once('SIGTERM', () => client.logout().finally(() => process.exit(0)));

  return {
    async loadState() {
      const [devices, s, limits] = await Promise.all([loadDevices(), routerStatus(), speedLimitSupport()]);
      firmware ??= await optional(client.request('admin/firmware?form=upgrade', { operation: 'read' }));
      const online = devices.filter(d => d.rate);
      const usage = v => v == null ? null : Number(v) > 1 ? Number(v) / 100 : Number(v);

      return {
        router: {
          name: firmware?.model ? `Mercusys ${firmware.model.replace(/^MERCUSYS\s*/i, '')}` : 'Mercusys MR60X',
          model: firmware?.hardware_version ?? null,
          firmware: firmware?.firmware_version ? `Firmware ${firmware.firmware_version}` : null,
          uptime: null,
          cpu: usage(s?.cpu_usage),
          memory: usage(s?.mem_usage),
        },
        wan: {
          label: 'All clients combined',
          down: online.reduce((sum, d) => sum + d.rate.down, 0),
          up: online.reduce((sum, d) => sum + d.rate.up, 0),
        },
        capabilities: { speedLimit: Boolean(limits), limitMax: limits },
        devices: devices.map(({ raw, ...d }) => d),
      };
    },

    async setBlocked(mac, blocked) {
      const device = await findDevice(mac);
      const blacklist = await loadBlacklist();
      const index = blacklist.findIndex(b => toMac(b.mac) === mac);

      if (!blocked) {
        if (index < 0) return;
        await client.request('admin/access_control?form=black_list', {
          operation: 'remove',
          key: blacklist[index].key ?? blacklist[index].mac,
          index,
        });
        return;
      }
      if (index >= 0) return;
      await ensureBlacklistMode();
      await client.request('admin/access_control?form=black_list', {
        operation: 'insert',
        key: 'add',
        old: 'add',
        index: 0,
        new: JSON.stringify({ name: device.name, mac: device.raw?.mac ?? routerMac(mac) }),
      });
    },

    async setLimit(mac, { down, up }) {
      const max = await speedLimitSupport();
      if (!max) throw httpError(409, 'This router firmware does not support per-device speed limits');
      if ((max.down && down > max.down) || (max.up && up > max.up)) {
        throw httpError(422, `The router allows at most ${max.down / 1e6} Mbps down / ${max.up / 1e6} Mbps up`);
      }
      const device = await findDevice(mac);
      if (!device.online) throw httpError(409, 'The router can only limit devices that are currently connected');
      await writeLimit(device, true, bpsToKbps(down), bpsToKbps(up));
    },

    async clearLimit(mac) {
      const device = await findDevice(mac);
      if (!device.limit) return;
      await writeLimit(device, false, bpsToKbps(device.limit.down), bpsToKbps(device.limit.up));
    },

    async rename(mac, name) {
      const device = await findDevice(mac);
      if (!device.canRename) throw httpError(409, 'Connect the device before renaming it');
      await client.request('admin/traffic?form=dev_name', { operation: 'write', mac: device.raw.mac, alias: name });
    },
  };
}
