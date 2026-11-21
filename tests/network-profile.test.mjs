import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { NetworkProfile } = require('../main/receiver/NetworkProfile.js');
const { LanAddress } = require('../main/receiver/LanAddress.js');
const { ReceiverController } = require('../main/receiver/ReceiverController.js');

const v4 = (address, internal = false) => ({ family: 'IPv4', address, internal });
const wifi = () => ({ 'Wi-Fi': [v4('192.168.1.23')], 'vEthernet (WSL)': [v4('172.20.0.1')], Loopback: [v4('127.0.0.1', true)] });

test('LanAddress.pickInterface returns the adapter name with the address', () => {
  assert.deepEqual(LanAddress.pickInterface(wifi()), { name: 'Wi-Fi', address: '192.168.1.23' });
  assert.equal(LanAddress.pickInterface({}), null);
  assert.equal(LanAddress.pick(wifi()), '192.168.1.23'); // the older call still works
});

test('NetworkProfile.parse accepts one network or a list, and normalises the labels', () => {
  assert.deepEqual(NetworkProfile.parse('{"alias":"Wi-Fi","category":"Public"}'), [{ alias: 'Wi-Fi', category: 'Public' }]);
  assert.deepEqual(NetworkProfile.parse('[{"alias":"Wi-Fi","category":"Private"},{"alias":"Ethernet","category":"DomainAuthenticated"},{"alias":"X","category":"Weird"},{"nope":1}]'),
    [{ alias: 'Wi-Fi', category: 'Private' }, { alias: 'Ethernet', category: 'Domain' }, { alias: 'X', category: 'Unknown' }]);
  assert.throws(() => NetworkProfile.parse('not json'));
});

test('NetworkProfile.current finds the type of the adapter the phone would use', async () => {
  const run = async () => JSON.stringify([{ alias: 'vEthernet (WSL)', category: 'Private' }, { alias: 'Wi-Fi', category: 'Public' }]);
  const n = new NetworkProfile({ interfaces: wifi, run, platform: 'win32' });
  assert.deepEqual(await n.current(), { interfaceName: 'Wi-Fi', address: '192.168.1.23', category: 'Public' });
});

test('NetworkProfile.current says Unknown (and never throws) when it cannot tell', async () => {
  const unknown = { interfaceName: 'Wi-Fi', address: '192.168.1.23', category: 'Unknown' };
  assert.deepEqual(await new NetworkProfile({ interfaces: wifi, platform: 'linux', run: async () => { throw new Error('must not run'); } }).current(), unknown);
  assert.deepEqual(await new NetworkProfile({ interfaces: wifi, platform: 'win32', run: async () => { throw new Error('no powershell'); } }).current(), unknown);
  assert.deepEqual(await new NetworkProfile({ interfaces: wifi, platform: 'win32', run: async () => 'garbage' }).current(), unknown);
  assert.deepEqual(await new NetworkProfile({ interfaces: wifi, platform: 'win32', run: async () => '[]' }).current(), unknown); // no match
  assert.deepEqual(await new NetworkProfile({ interfaces: () => ({}), platform: 'win32', run: async () => '[]' }).current(),
    { interfaceName: null, address: null, category: 'Unknown' }); // no network at all
});

test('controller: status carries the network, changes are announced once, and watching stops on switch-off', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskplan-net-'));
  let category = 'Public';
  let lookups = 0;
  const controller = new ReceiverController({
    dir, port: 0, networkCheckMs: 20,
    announcer: { start() {}, stop() {} },
    network: { current: async () => { lookups++; return { interfaceName: 'Wi-Fi', address: '192.168.1.23', category }; } },
  });
  t.after(() => controller.stop());
  assert.equal(controller.status().network, null);

  let changes = 0;
  controller.on('devices', () => { changes++; });
  await controller.setEnabled(true);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(controller.status().network.category, 'Public');
  assert.ok(lookups >= 2, 'looks again on its own while receiving is on');
  const afterFirst = changes;

  category = 'Private'; // the user switched to their hotspot
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(controller.status().network.category, 'Private');
  assert.ok(changes > afterFirst, 'the screen is told when the network type changes');

  const settled = changes;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(changes, settled, 'no repeated announcements while nothing changes');

  await controller.setEnabled(false);
  const stopped = lookups;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(lookups, stopped, 'stops checking when receiving is off');
});
