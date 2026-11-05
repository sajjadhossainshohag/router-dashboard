import { httpError } from './errors.js';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_EVENTS = 200;
const KEEP_DAYS = 62;
const MAX_GAP_S = 30;
const MAX_TIMER_MIN = 7 * 24 * 60;

const pad = n => String(n).padStart(2, '0');
export const dateKey = t => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const toMinutes = hhmm => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
const toKbpsBps = mbps => Math.round(Number(mbps) * 1000) * 1000;
const sameLimit = (a, b) => Boolean(a && b) && a.down === b.down && a.up === b.up;
const fmtMbps = bps => bps ? `${+(bps / 1e6).toFixed(2)} Mbps` : 'unlimited';
const fmtLimit = l => `${fmtMbps(l.down)} down / ${fmtMbps(l.up)} up`;

function scheduleInstance(s, now) {
  const d = new Date(now);
  const t = d.getHours() * 60 + d.getMinutes();
  const start = toMinutes(s.start), end = toMinutes(s.end);
  if (start < end) return s.days.includes(d.getDay()) && t >= start && t < end ? dateKey(d) : null;
  if (t >= start && s.days.includes(d.getDay())) return dateKey(d);
  const yesterday = new Date(d);
  yesterday.setDate(d.getDate() - 1);
  return t < end && s.days.includes(yesterday.getDay()) ? dateKey(yesterday) : null;
}

export function createAutomation({ router, store, clock = Date.now }) {
  const db = store.data;
  const names = new Map();
  const reported = new Set();
  let caps = { speedLimit: false, limitMax: null };
  let lastSample = 0;
  let lastPrune = '';

  const nameOf = mac => names.get(mac) ?? mac;

  function log(type, mac, message) {
    db.events.unshift({ t: clock(), type, mac, name: mac && nameOf(mac), message });
    db.events.length = Math.min(db.events.length, MAX_EVENTS);
    store.save();
  }

  function usageOf(mac, now) {
    const days = db.usage[mac] ?? {};
    const [td = 0, tu = 0] = days[dateKey(now)] ?? [];
    const month = dateKey(now).slice(0, 7);
    let md = 0, mu = 0;
    for (const [day, [d, u]] of Object.entries(days)) if (day.startsWith(month)) { md += d; mu += u; }
    return { today: { down: td, up: tu }, month: { down: md, up: mu } };
  }

  function recordUsage(devices, now) {
    const dt = lastSample ? Math.min((now - lastSample) / 1000, MAX_GAP_S) : 0;
    lastSample = now;
    if (dt <= 0) return;
    const day = dateKey(now);
    for (const d of devices) {
      if (!d.rate || !(d.rate.down || d.rate.up)) continue;
      const bucket = (db.usage[d.mac] ??= {})[day] ??= [0, 0];
      bucket[0] += Math.round(d.rate.down / 8 * dt);
      bucket[1] += Math.round(d.rate.up / 8 * dt);
    }
    if (lastPrune !== day) {
      lastPrune = day;
      const oldest = dateKey(now - KEEP_DAYS * 86400_000);
      for (const days of Object.values(db.usage)) for (const k of Object.keys(days)) if (k < oldest) delete days[k];
    }
  }

  function reasons(mac, now) {
    const rule = db.rules[mac];
    if (!rule) return [];
    const out = [];
    if (rule.timer && rule.timer.until > now) {
      out.push({ key: `timer:${rule.timer.until}`, source: 'timer', kind: rule.timer.action, limit: rule.timer.limit, until: rule.timer.until });
    }
    for (const s of rule.schedules ?? []) {
      const instance = scheduleInstance(s, now);
      if (instance) out.push({ key: `schedule:${s.start}-${s.end}:${instance}`, source: 'schedule', kind: 'block', end: s.end });
    }
    if (rule.quota) {
      const { today } = usageOf(mac, now);
      if (today.down + today.up >= rule.quota.bytes) {
        out.push({ key: `quota:${dateKey(now)}`, source: 'quota', kind: rule.quota.action, limit: rule.quota.limit });
      }
    }
    return out;
  }

  const describe = r => r.source === 'timer' ? 'timer' : r.source === 'schedule' ? `schedule until ${r.end}` : 'daily data cap reached';

  function reportOnce(key, mac, err) {
    if (reported.has(key)) return;
    reported.add(key);
    log('error', mac, err.message);
  }

  async function enforce(device, now) {
    const { mac } = device;
    const rule = db.rules[mac];
    if (rule?.timer && rule.timer.until <= now) delete rule.timer;

    const all = reasons(mac, now);
    const skip = (db.skip[mac] ?? []).filter(k => all.some(r => r.key === k));
    if (skip.length) db.skip[mac] = skip; else delete db.skip[mac];
    const active = all.filter(r => !skip.includes(r.key));
    const wantBlock = active.find(r => r.kind === 'block');
    const wantLimit = active.find(r => r.kind === 'limit');
    const applied = db.applied[mac] ?? {};
    let wrote = false;

    try {
      if (applied.block && !device.blocked) {
        if (wantBlock) (db.skip[mac] ??= []).push(wantBlock.key);
        delete applied.block;
        log('override', mac, 'Unblocked outside the dashboard; rule paused until it next starts');
      } else if (applied.block && !wantBlock) {
        await router.setBlocked(mac, false);
        delete applied.block;
        wrote = true;
        log('unblock', mac, 'Unblocked: rule ended');
      } else if (applied.block) {
        applied.block = wantBlock.key;
      } else if (wantBlock && !device.blocked) {
        await router.setBlocked(mac, true);
        applied.block = wantBlock.key;
        wrote = true;
        log('block', mac, `Blocked: ${describe(wantBlock)}`);
      }
    } catch (err) {
      reportOnce(`block:${wantBlock?.key}:${err.message}`, mac, err);
    }

    try {
      if (wantLimit) {
        applied.limit ??= { prev: device.limit ?? null };
        if (device.online && !sameLimit(device.limit, wantLimit.limit)) {
          await router.setLimit(mac, wantLimit.limit);
          wrote = true;
          if (applied.limit.key !== wantLimit.key) log('limit', mac, `Slowed to ${fmtLimit(wantLimit.limit)}: ${describe(wantLimit)}`);
        }
        if (device.online) applied.limit.key = wantLimit.key;
      } else if (applied.limit && device.online) {
        const { prev } = applied.limit;
        await (prev ? router.setLimit(mac, prev) : router.clearLimit(mac));
        delete applied.limit;
        wrote = true;
        log('restore', mac, prev ? `Speed limit restored to ${fmtLimit(prev)}` : 'Speed limit removed: rule ended');
      }
    } catch (err) {
      reportOnce(`limit:${wantLimit?.key}:${err.message}`, mac, err);
    }

    if (applied.block || applied.limit) db.applied[mac] = applied; else delete db.applied[mac];
    return wrote;
  }

  async function guardNewDevices(devices, now) {
    const seeding = !Object.keys(db.known).length;
    let wrote = false;
    for (const d of devices) {
      if (db.known[d.mac]) continue;
      db.known[d.mac] = now;
      if (seeding) continue;
      if (db.settings.guard && !d.blocked) {
        try {
          await router.setBlocked(d.mac, true);
          wrote = true;
          log('new', d.mac, 'New device joined and was blocked (new-device guard is on)');
        } catch (err) {
          log('error', d.mac, `New device joined but blocking failed: ${err.message}`);
        }
      } else {
        log('new', d.mac, 'New device joined the network');
      }
    }
    return wrote;
  }

  function parseLimit(input) {
    if (!caps.speedLimit) throw httpError(409, 'This router firmware does not support per-device speed limits');
    const down = Number(input?.down ?? 0), up = Number(input?.up ?? 0);
    if (![down, up].every(n => Number.isFinite(n) && n >= 0 && n <= 10000)) throw httpError(422, 'Limits must be between 0 and 10000 Mbps');
    if (!down && !up) throw httpError(422, 'Set a download or upload speed');
    const limit = { down: toKbpsBps(down), up: toKbpsBps(up) };
    const max = caps.limitMax;
    if ((max?.down && limit.down > max.down) || (max?.up && limit.up > max.up)) {
      throw httpError(422, `The router allows at most ${max.down / 1e6} Mbps down / ${max.up / 1e6} Mbps up`);
    }
    return limit;
  }

  function parseSchedules(input) {
    if (!Array.isArray(input) || input.length > 8) throw httpError(422, 'Up to 8 schedules per device');
    return input.map(s => {
      const days = [...new Set((s?.days ?? []).map(Number))].filter(d => Number.isInteger(d) && d >= 0 && d <= 6).sort();
      if (!days.length) throw httpError(422, 'Pick at least one day for each schedule');
      if (!TIME_RE.test(s.start) || !TIME_RE.test(s.end)) throw httpError(422, 'Schedule times must be HH:MM');
      if (s.start === s.end) throw httpError(422, 'A schedule must start and end at different times');
      return { days, start: s.start, end: s.end };
    });
  }

  function parseQuota(input) {
    if (!input) return null;
    const gb = Number(input.gb);
    if (!Number.isFinite(gb) || gb < 0.001 || gb > 100000) throw httpError(422, 'Daily data cap must be between 1 MB and 100000 GB');
    if (input.action !== 'block' && input.action !== 'limit') throw httpError(422, 'Cap action must be block or limit');
    return { bytes: Math.round(gb * 1e9), action: input.action, ...(input.action === 'limit' && { limit: parseLimit(input.limit) }) };
  }

  const ruleFor = mac => db.rules[mac] ??= {};
  const pruneRule = mac => {
    const r = db.rules[mac];
    if (r && !r.timer && !r.quota && !r.schedules?.length) delete db.rules[mac];
  };

  return {
    async tick(state) {
      const now = clock();
      caps = state.capabilities ?? caps;
      for (const d of state.devices) names.set(d.mac, d.name);
      recordUsage(state.devices, now);
      let wrote = await guardNewDevices(state.devices, now);
      for (const d of state.devices) wrote = (await enforce(d, now)) || wrote;
      store.save();
      return wrote;
    },

    log,

    manual(mac, kind) {
      const keys = reasons(mac, clock()).filter(r => r.kind === kind).map(r => r.key);
      if (keys.length) db.skip[mac] = [...new Set([...(db.skip[mac] ?? []), ...keys])];
      if (db.applied[mac]) {
        delete db.applied[mac][kind];
        if (!db.applied[mac].block && !db.applied[mac].limit) delete db.applied[mac];
      }
      store.save();
    },

    setRules(mac, input) {
      const schedules = parseSchedules(input.schedules ?? []);
      const quota = parseQuota(input.quota);
      Object.assign(ruleFor(mac), { schedules, quota });
      pruneRule(mac);
      log('rules', mac, 'Rules updated');
    },

    setTimer(mac, input) {
      const minutes = Number(input.minutes);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_TIMER_MIN) throw httpError(422, 'Timer must be 1 minute to 7 days');
      if (input.action !== 'block' && input.action !== 'limit') throw httpError(422, 'Timer action must be block or limit');
      const timer = { action: input.action, until: clock() + minutes * 60_000, ...(input.action === 'limit' && { limit: parseLimit(input.limit) }) };
      ruleFor(mac).timer = timer;
      log('rules', mac, input.action === 'block' ? `Timer: blocked for ${minutes} min` : `Timer: slowed to ${fmtLimit(timer.limit)} for ${minutes} min`);
    },

    clearTimer(mac) {
      if (!db.rules[mac]?.timer) return;
      delete db.rules[mac].timer;
      pruneRule(mac);
      log('rules', mac, 'Timer cancelled');
    },

    setSettings(input) {
      if (typeof input.guard === 'boolean' && input.guard !== db.settings.guard) {
        db.settings.guard = input.guard;
        log('settings', null, `New-device guard turned ${input.guard ? 'on' : 'off'}`);
      }
    },

    view(mac) {
      const now = clock();
      const rule = db.rules[mac] ?? {};
      const skip = db.skip[mac] ?? [];
      return {
        usage: usageOf(mac, now),
        rules: { schedules: rule.schedules ?? [], quota: rule.quota ?? null, timer: rule.timer?.until > now ? rule.timer : null },
        active: reasons(mac, now).map(({ key, ...r }) => ({ ...r, paused: skip.includes(key) })),
      };
    },

    summary: () => ({ settings: db.settings, events: db.events.slice(0, 60) }),
  };
}
