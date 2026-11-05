import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutomation } from '../automation.js';
import { createStore } from '../store.js';

const at = (day, hh, mm = 0) => new Date(2026, 10, day, hh, mm).getTime();
const THU = 4;

function setup(devices, start) {
  const list = devices.map(d => ({ online: true, blocked: false, limit: null, rate: { down: 0, up: 0 }, name: d.mac, ...d }));
  const router = {
    setBlocked: async (mac, blocked) => { const d = list.find(x => x.mac === mac); d.blocked = blocked; d.online = !blocked; if (blocked) d.rate = null; },
    setLimit: async (mac, limit) => { list.find(x => x.mac === mac).limit = { ...limit }; },
    clearLimit: async mac => { list.find(x => x.mac === mac).limit = null; },
  };
  const clock = { now: start };
  const store = createStore(null);
  const auto = createAutomation({ router, store, clock: () => clock.now });
  const tick = async t => {
    if (t) clock.now = t;
    return auto.tick({ devices: structuredClone(list), capabilities: { speedLimit: true, limitMax: null } });
  };
  return { list, auto, tick, clock, store, dev: mac => list.find(d => d.mac === mac) };
}

const A = 'AA:AA:AA:AA:AA:01', B = 'AA:AA:AA:AA:AA:02';

test('overnight schedule blocks at start and unblocks at end', async () => {
  const { auto, tick, dev } = setup([{ mac: A }], at(5, 21, 59));
  await tick();
  auto.setRules(A, { schedules: [{ days: [THU], start: '22:00', end: '07:00' }] });
  await tick();
  assert.equal(dev(A).blocked, false);
  await tick(at(5, 22, 0));
  assert.equal(dev(A).blocked, true);
  await tick(at(6, 6, 59));
  assert.equal(dev(A).blocked, true);
  await tick(at(6, 7, 0));
  assert.equal(dev(A).blocked, false);
});

test('unblocking during a schedule pauses it for that night only', async () => {
  const { auto, tick, dev } = setup([{ mac: A }], at(5, 23, 0));
  await tick();
  auto.setRules(A, { schedules: [{ days: [4, 5], start: '22:00', end: '07:00' }] });
  await tick();
  assert.equal(dev(A).blocked, true);
  dev(A).blocked = false;
  await tick(at(5, 23, 30));
  await tick(at(5, 23, 31));
  assert.equal(dev(A).blocked, false);
  assert.ok(auto.view(A).active[0].paused);
  await tick(at(6, 22, 0));
  assert.equal(dev(A).blocked, true);
});

test('dashboard override and manual blocks are respected', async () => {
  const { auto, tick, dev } = setup([{ mac: A }, { mac: B, blocked: true }], at(5, 23, 0));
  await tick();
  auto.setRules(A, { schedules: [{ days: [THU], start: '22:00', end: '23:59' }] });
  auto.setRules(B, { schedules: [{ days: [THU], start: '22:00', end: '23:59' }] });
  await tick();
  auto.manual(A, 'block');
  dev(A).blocked = false;
  await tick(at(5, 23, 10));
  assert.equal(dev(A).blocked, false);
  await tick(at(6, 0, 0));
  assert.equal(dev(B).blocked, true, 'a device blocked by hand stays blocked when a rule ends');
});

test('timer limit restores the previous limit when it ends', async () => {
  const { auto, tick, dev } = setup([{ mac: A, limit: { down: 10e6, up: 5e6 } }], at(5, 12));
  await tick();
  auto.setTimer(A, { action: 'limit', minutes: 30, limit: { down: 1, up: 0.5 } });
  await tick();
  assert.deepEqual(dev(A).limit, { down: 1e6, up: 0.5e6 });
  await tick(at(5, 12, 31));
  assert.deepEqual(dev(A).limit, { down: 10e6, up: 5e6 });
  assert.equal(auto.view(A).rules.timer, null);
});

test('daily data cap blocks until midnight and usage is counted', async () => {
  const { auto, tick, dev, clock } = setup([{ mac: A, rate: { down: 80e6, up: 8e6 } }], at(5, 10));
  await tick();
  auto.setRules(A, { quota: { gb: 0.2, action: 'block' } });
  clock.now += 10_000;
  await tick();
  assert.equal(auto.view(A).usage.today.down, 100e6);
  assert.equal(dev(A).blocked, false);
  clock.now += 10_000;
  await tick();
  assert.equal(dev(A).blocked, true);
  await tick(at(6, 0, 1));
  assert.equal(dev(A).blocked, false);
  assert.equal(auto.view(A).usage.month.down, 200e6);
});

test('new-device guard blocks devices that join after the first scan', async () => {
  const { auto, tick, dev, list, store } = setup([{ mac: A }], at(5, 10));
  await tick();
  assert.equal(store.data.events.length, 0);
  auto.setSettings({ guard: true });
  list.push({ mac: B, name: 'Stranger', online: true, blocked: false, limit: null, rate: null });
  await tick();
  assert.equal(dev(B).blocked, true);
  assert.equal(dev(A).blocked, false);
  assert.match(store.data.events[0].message, /blocked/);
});

test('rule validation rejects bad input', () => {
  const { auto } = setup([{ mac: A }], at(5, 10));
  assert.throws(() => auto.setRules(A, { schedules: [{ days: [], start: '22:00', end: '07:00' }] }), /at least one day/);
  assert.throws(() => auto.setRules(A, { schedules: [{ days: [1], start: '7:00', end: '08:00' }] }), /HH:MM/);
  assert.throws(() => auto.setTimer(A, { action: 'block', minutes: 0 }), /1 minute/);
  assert.throws(() => auto.setRules(A, { quota: { gb: 1, action: 'nuke' } }), /block or limit/);
});
