const test = require('node:test');
const assert = require('node:assert/strict');
const { checkStudioClosed, createProductionWrite } = require('../src/writeback');

function fixture() {
  return {
    platform: 'linux',
    readFile: async () => 'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\n',
    realpath: async () => '/opt/studio/studio',
    readdir: async () => ['1', '42', 'self'],
    readlink: async pid => pid === '/proc/42/exe' ? '/usr/bin/other' : '/usr/bin/init',
  };
}
test('process scan accepts a complete negative snapshot', async () => {
  await checkStudioClosed('/opt/studio/resources/app.asar', fixture());
});
test('process scan refuses configured, renamed and deleted Studio executables', async () => {
  for (const target of ['/opt/studio/studio', '/elsewhere/BYOK-Studio', '/opt/studio/studio (deleted)']) {
    const env = fixture(); env.readlink = async () => target;
    await assert.rejects(checkStudioClosed('/opt/studio/resources/app.asar', env), /Studio appears to be running/);
  }
});
test('process scan refuses unsupported, filtered, incomplete and failed inspection', async () => {
  const variants = [
    { platform: 'darwin' },
    { readFile: async () => 'proc /proc proc rw,hidepid=2 0 0\n' },
    { readFile: async () => '' },
    { readdir: async () => [] },
    { readdir: async () => { throw Error('denied'); } },
    { readlink: async () => { throw Error('disappeared or denied'); } },
    { realpath: async () => { throw Error('missing'); } },
  ];
  for (const override of variants) await assert.rejects(checkStudioClosed('/opt/studio/resources/app.asar', { ...fixture(), ...override }), /unavailable|uncertain/);
});
test('production gate defaults disabled, checks before writing, and forwards both modes', async () => {
  let checks = 0, calls = [];
  const write = createProductionWrite(async () => { checks++; }, async (...args) => { calls.push(args); return 'written'; });
  for (const value of [undefined, false, 'true']) await assert.rejects(write('db', 'row', 'html', 'asar', true, value), /disabled/);
  assert.equal(checks, 0); assert.equal(calls.length, 0);
  assert.equal(await write('db', 'row', 'html', 'asar', true, true), 'written');
  assert.equal(checks, 1); assert.deepEqual(calls, [['db', 'row', 'html', 'asar', true]]);
  const refused = createProductionWrite(async () => { throw Error('inspection failed'); }, async () => assert.fail('write reached'));
  await assert.rejects(refused('db', 'row', 'html', 'asar', false, true), /inspection failed/);
});
