const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { startHeartbeat } = require('../src/utils/heartbeat');

test('startHeartbeat writes the file immediately and stop() halts further writes', async () => {
  const file = path.join(os.tmpdir(), `bot-test-heartbeat-${crypto.randomUUID()}`, 'heartbeat');

  const stop = startHeartbeat(file, 20);
  assert.ok(fs.existsSync(file), 'heartbeat file should exist immediately, not only after the first interval');

  const firstWrite = fs.readFileSync(file, 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 60));
  const secondWrite = fs.readFileSync(file, 'utf8');
  assert.notEqual(firstWrite, secondWrite, 'the timer should have written again within 60ms at a 20ms interval');

  stop();
  const afterStop = fs.readFileSync(file, 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(fs.readFileSync(file, 'utf8'), afterStop, 'no further writes should happen after stop()');

  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
