const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-scheduler-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';
// Redis is expected to be unreachable in test environments; queue.js/scheduler.js
// must degrade gracefully rather than throw, which this test also exercises.
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = '1'; // guaranteed-closed port, fails fast instead of a long OS timeout

const deepseek = require('../src/services/deepseek');
deepseek.summarize = async () => 'stub summary';

// scheduler.js sends DMs via a standalone Telegram client — stub it before
// scheduler.js (which constructs one at module load) is required.
const { Telegram } = require('telegraf');
const sentMessages = [];
Telegram.prototype.sendMessage = async function (chatId, text) {
  sentMessages.push({ chatId, text });
  return { message_id: 1 };
};

const db = require('../src/services/database');
const { connection } = require('../src/services/queue');
const { runDueDigests } = require('../src/services/scheduler');

test.after(async () => {
  db.db.close();
  // ioredis retries indefinitely by design; without disconnecting, the
  // process never goes idle and `node --test` hangs after tests pass.
  connection.disconnect();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

function withUtcHour(hour, fn) {
  const RealDate = Date;
  global.Date = class extends RealDate {
    getUTCHours() {
      return hour;
    }
  };
  return Promise.resolve(fn()).finally(() => {
    global.Date = RealDate;
  });
}

test('runDueDigests DMs an active-subscription user whose digest is due', async () => {
  const user = { id: 300, username: 'u', first_name: 'U' };
  const chat = { id: -300, title: 'Sched', type: 'group' };
  db.getOrCreateUser({ id: user.id, username: user.username, firstName: user.first_name });
  db.getOrCreateChat({ id: chat.id, title: chat.title, type: chat.type });
  db.linkUserToChat(chat.id, user.id);
  db.saveMessage({ chatId: chat.id, messageId: 1, userId: user.id, username: 'u', text: 'hi' });
  db.createSubscription({
    userId: user.id,
    plan: 'monthly',
    starsPaid: 150,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  db.setScheduledDigest({ chatId: chat.id, userId: user.id, hourUtc: 9 });

  const before = sentMessages.length;
  await withUtcHour(9, () => runDueDigests());

  assert.equal(sentMessages.length, before + 1);
  assert.equal(sentMessages[sentMessages.length - 1].chatId, user.id);
});

test('runDueDigests skips a user whose subscription has lapsed', async () => {
  const user = { id: 301, username: 'v', first_name: 'V' };
  const chat = { id: -301, title: 'Sched2', type: 'group' };
  db.getOrCreateUser({ id: user.id, username: user.username, firstName: user.first_name });
  db.getOrCreateChat({ id: chat.id, title: chat.title, type: chat.type });
  db.linkUserToChat(chat.id, user.id);
  db.saveMessage({ chatId: chat.id, messageId: 1, userId: user.id, username: 'v', text: 'hi' });
  // Deliberately no active subscription for this user.
  db.setScheduledDigest({ chatId: chat.id, userId: user.id, hourUtc: 10 });

  const before = sentMessages.length;
  await withUtcHour(10, () => runDueDigests());

  assert.equal(sentMessages.length, before, 'no DM should be sent for a lapsed subscription');
});

test('runDueDigests does not act on digests scheduled for a different hour', async () => {
  const user = { id: 302, username: 'w', first_name: 'W' };
  const chat = { id: -302, title: 'Sched3', type: 'group' };
  db.getOrCreateUser({ id: user.id, username: user.username, firstName: user.first_name });
  db.getOrCreateChat({ id: chat.id, title: chat.title, type: chat.type });
  db.linkUserToChat(chat.id, user.id);
  db.saveMessage({ chatId: chat.id, messageId: 1, userId: user.id, username: 'w', text: 'hi' });
  db.createSubscription({
    userId: user.id,
    plan: 'monthly',
    starsPaid: 150,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  db.setScheduledDigest({ chatId: chat.id, userId: user.id, hourUtc: 15 });

  const before = sentMessages.length;
  await withUtcHour(16, () => runDueDigests());

  assert.equal(sentMessages.length, before);
});
