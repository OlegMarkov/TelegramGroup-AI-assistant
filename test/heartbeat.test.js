const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { startHeartbeat } = require('../src/utils/heartbeat');

function tmpFile() {
  return path.join(os.tmpdir(), `bot-test-heartbeat-${crypto.randomUUID()}`, 'heartbeat');
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('startHeartbeat writes the file immediately and stop() halts further writes', async () => {
  const file = tmpFile();

  const stop = startHeartbeat(file, { intervalMs: 20 });
  assert.ok(fs.existsSync(file), 'heartbeat file should exist immediately, not only after the first interval');

  const firstWrite = fs.readFileSync(file, 'utf8');
  await wait(60);
  const secondWrite = fs.readFileSync(file, 'utf8');
  assert.notEqual(firstWrite, secondWrite, 'the timer should have written again within 60ms at a 20ms interval');

  stop();
  const afterStop = fs.readFileSync(file, 'utf8');
  await wait(60);
  assert.equal(fs.readFileSync(file, 'utf8'), afterStop, 'no further writes should happen after stop()');

  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('heartbeat goes stale when isAlive() turns false, so a deaf bot reports unhealthy', async () => {
  const file = tmpFile();
  let alive = true;

  const stop = startHeartbeat(file, { intervalMs: 20, isAlive: () => alive });
  await wait(60);
  const whileAlive = fs.readFileSync(file, 'utf8');

  // Simulate the polling loop dying while the process stays up — the exact
  // failure the old healthcheck could not see.
  alive = false;
  await wait(80);

  assert.equal(
    fs.readFileSync(file, 'utf8'),
    whileAlive,
    'file must stop being refreshed once polling is dead, so healthcheck.js sees it go stale'
  );

  // Recovery: if polling comes back, the heartbeat resumes.
  alive = true;
  await wait(60);
  assert.notEqual(fs.readFileSync(file, 'utf8'), whileAlive, 'heartbeat should resume when polling recovers');

  stop();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('isAlive() false from the very start writes no file at all', async () => {
  const file = tmpFile();

  const stop = startHeartbeat(file, { intervalMs: 20, isAlive: () => false });
  await wait(50);

  assert.equal(fs.existsSync(file), false, 'a bot that never starts polling must never look healthy');

  stop();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
