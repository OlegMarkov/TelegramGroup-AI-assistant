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
const { runDueDigests, runRetentionSweep, startRetentionSweeps } = require('../src/services/scheduler');

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

test('a retried tick does not re-deliver a digest already sent this hour', async () => {
  // BullMQ retries a job that threw, and a container restart leaves a tick
  // unfinished — either one used to re-send every digest already delivered
  // that hour, because nothing read the column markDigestSent() writes.
  const userId = 305;
  const chatId = -305;
  db.getOrCreateUser({ id: userId, username: 'retry', firstName: 'R' });
  db.getOrCreateChat({ id: chatId, title: 'Retried', type: 'group' });
  db.linkUserToChat(chatId, userId);
  db.createSubscription({
    userId,
    plan: 'monthly',
    starsPaid: 300,
    expiresAt: new Date(Date.now() + 30 * 86400000).toISOString().replace('T', ' ').slice(0, 19),
  });
  db.saveMessage({ chatId, messageId: 1, userId, username: 'retry', text: 'something worth summarizing' });
  db.setScheduledDigest({ chatId, userId, hourUtc: 5 });

  const before = sentMessages.length;
  await withUtcHour(5, () => runDueDigests());
  const afterFirst = sentMessages.length;
  assert.ok(afterFirst > before, 'the digest is delivered on the first tick');

  // The very same hour, as a retry would run it.
  await withUtcHour(5, () => runDueDigests());
  assert.equal(sentMessages.length, afterFirst, 'the retry delivers nothing further');

  // Tomorrow's tick must still fire, so the guard is per-hour and not a
  // permanent latch.
  db.db
    .prepare(`UPDATE scheduled_digests SET last_sent_at = datetime('now', '-1 days') WHERE chat_id = ? AND user_id = ?`)
    .run(chatId, userId);
  await withUtcHour(5, () => runDueDigests());
  assert.ok(sentMessages.length > afterFirst, 'the next day still delivers');
});

test('retention sweeps run and delete without Redis, because a privacy promise cannot depend on a cache', async () => {
  // This whole file runs with REDIS_PORT pointed at a guaranteed-closed port,
  // so the sweep completing here IS the assertion: retention used to ride the
  // BullMQ tick, which meant a Redis outage silently stopped enforcing the
  // deletion PRIVACY.md promises, while the bot carried on looking healthy.
  assert.notEqual(connection.status, 'ready', 'the point of this test is that Redis is unreachable');

  db.getOrCreateUser({ id: 320, username: 'ret', firstName: 'R' });
  db.getOrCreateChat({ id: -320, title: 'Ageing', type: 'group' });
  db.saveMessage({
    chatId: -320,
    messageId: 1,
    userId: 320,
    username: 'ret',
    text: 'past its retention window',
    createdAt: '2000-01-01T00:00:00.000Z',
  });
  db.saveMessage({ chatId: -320, messageId: 2, userId: 320, username: 'ret', text: 'recent' });

  // A chat the bot was removed from, past the grace period.
  db.getOrCreateChat({ id: -321, title: 'Removed', type: 'group' });
  db.saveMessage({ chatId: -321, messageId: 1, userId: 320, username: 'ret', text: 'orphaned' });
  db.deactivateChat(-321);
  db.db
    .prepare(`UPDATE chats SET deactivated_at = datetime('now', '-30 days') WHERE id = -321`)
    .run();

  const stop = startRetentionSweeps();
  try {
    const kept = db.db.prepare('SELECT text FROM messages WHERE chat_id = -320').all();
    assert.deepEqual(kept.map((m) => m.text), ['recent'], 'only the expired message is deleted');
    assert.equal(
      db.db.prepare('SELECT COUNT(*) c FROM messages WHERE chat_id = -321').get().c,
      0,
      'a chat the bot was removed from is purged after the grace period'
    );

    // Persisted, so a restart cannot reset the clock and hide a sweep that
    // stopped happening.
    const sweptAt = Number(db.getAppState('retention_swept_at'));
    assert.ok(sweptAt > 0 && Date.now() - sweptAt < 60000);

    // The BullMQ tick still calls the sweep. With the timer having just run
    // one, the second caller must be a no-op rather than duplicated work.
    assert.equal(runRetentionSweep(), false, 'a sweep this recent is skipped');
    assert.equal(runRetentionSweep({ force: true }), true, 'and force still overrides the gap');
  } finally {
    stop();
  }
});
