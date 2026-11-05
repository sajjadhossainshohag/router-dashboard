import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAes, formEncode } from '../drivers/mercusys/client.js';
import { createMercusysClient } from '../drivers/mercusys/client.js';
import { createMercusysDriver } from '../drivers/mercusys/index.js';
import { startFakeMercusys } from '../drivers/mercusys/fake-router.js';

test('AES round-trips and matches CryptoJS key/iv format', () => {
  const aes = createAes();
  assert.match(aes.key, /^\d{16}$/);
  assert.match(aes.iv, /^\d{16}$/);
  assert.equal(aes.decrypt(aes.encrypt('operation=read&x=ü')), 'operation=read&x=ü');
});

test('form encoding repeats array keys like jQuery.param(traditional)', () => {
  assert.equal(formEncode({ operation: 'remove', key: ['a', 'b'], index: [0, 1] }), 'operation=remove&key=a&key=b&index=0&index=1');
});

test('driver works end to end against the fake MR60X', async () => {
  const fake = await startFakeMercusys();
  const driver = await createMercusysDriver({ ROUTER_URL: fake.url, ROUTER_PASS: fake.password }, { mock: false });

  let state = await driver.loadState();
  assert.equal(state.router.name, 'Mercusys MR60X');
  assert.equal(state.capabilities.speedLimit, true);
  assert.equal(state.devices.length, 7);
  const tv = state.devices.find(d => d.name === 'LivingRoom-TV');
  assert.equal(tv.mac, '00:1A:79:44:5C:02');
  assert.equal(tv.connection, 'wired');
  const phone = state.devices.find(d => d.name === 'Johns-iPhone');
  assert.equal(phone.signal, -52);

  await driver.setLimit(tv.mac, { down: 4e6, up: 1e6 });
  state = await driver.loadState();
  assert.deepEqual(state.devices.find(d => d.mac === tv.mac).limit, { down: 4e6, up: 1e6 });
  await new Promise(r => setTimeout(r, 1100));
  state = await driver.loadState();
  assert.ok(state.devices.find(d => d.mac === tv.mac).rate.down <= 4e6 + 8);

  await driver.setLimit(tv.mac, { down: 2e6, up: 0 });
  state = await driver.loadState();
  assert.deepEqual(state.devices.find(d => d.mac === tv.mac).limit, { down: 2e6, up: 0 });

  await driver.clearLimit(tv.mac);
  state = await driver.loadState();
  assert.equal(state.devices.find(d => d.mac === tv.mac).limit, null);

  await assert.rejects(driver.setLimit(tv.mac, { down: 2e9, up: 0 }), /at most 1000 Mbps/);

  await driver.setBlocked(phone.mac, true);
  state = await driver.loadState();
  const blockedPhone = state.devices.find(d => d.mac === phone.mac);
  assert.equal(blockedPhone.blocked, true);
  assert.equal(blockedPhone.online, false);

  await driver.setBlocked(tv.mac, true);
  await driver.setBlocked(phone.mac, false);
  state = await driver.loadState();
  assert.equal(state.devices.find(d => d.mac === phone.mac).blocked, false);
  assert.equal(state.devices.find(d => d.mac === tv.mac).blocked, true);
  await driver.setBlocked(tv.mac, false);

  await driver.rename(phone.mac, 'Phone (John)');
  state = await driver.loadState();
  assert.equal(state.devices.find(d => d.mac === phone.mac).name, 'Phone (John)');
  fake.server.close();
});

test('client re-logs in when the session is taken over', async () => {
  const fake = await startFakeMercusys();
  const a = createMercusysClient({ url: fake.url, password: fake.password });
  const b = createMercusysClient({ url: fake.url, password: fake.password });
  await a.request('admin/status?form=all', { operation: 'read' });
  await b.request('admin/status?form=all', { operation: 'read' });
  const status = await a.request('admin/status?form=all', { operation: 'read' });
  assert.ok(status.cpu_usage >= 0);
  fake.server.close();
});

test('wrong password fails once and then stops hitting the router', async () => {
  const fake = await startFakeMercusys();
  let logins = 0;
  fake.server.on('request', req => { if (req.url.includes('form=login')) logins++; });
  const client = createMercusysClient({ url: fake.url, password: 'wrong' });
  await assert.rejects(client.request('admin/status?form=all', { operation: 'read' }), /wrong ROUTER_PASS/);
  await assert.rejects(client.request('admin/status?form=all', { operation: 'read' }), /wrong ROUTER_PASS/);
  assert.equal(logins, 1);
  fake.server.close();
});
