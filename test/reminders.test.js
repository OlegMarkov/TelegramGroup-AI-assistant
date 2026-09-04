const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-reminders-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';
// Same as the scheduler suite: Redis is deliberately unreachable.
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = '1';

const { Telegram } = require('telegraf');
const sent = [];
const sendScript = new Map();

Telegram.prototype.sendMessage = async function (chatId, text, extra) {
  const queued = sendScript.get(chatId);
  const next = queued && queued.length > 0 ? queued.shift() : null;
  if (next) throw next;
  sent.push({ chatId, text, extra });
  return { message_id: 1 };
};

function telegramError(code, description) {
  const error = new Error(`${code}: ${description}`);
  error.response = { error_code: code, description };
  error.code = code;
  error.description = description;
  return error;
}

const db = require('../src/services/database');
const { connection } = require('../src/services/queue');
const { runExpiryReminders } = require('../src/services/scheduler');
const { formatDate } = require('../src/utils/formatters');
const { FREE_LIMITS } = require('../src/models/subscription');

test.after(async () => {
  db.db.close();
  connection.disconnect();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

const noSleep = { sleep: async () => {} };

/**
 * Expiries are written in SQLite's own "YYYY-MM-DD HH:MM:SS" via formatDate,
 * which is what payments.js stores. Using an ISO string here instead would
 * compare wrongly against datetime('now') on the day of expiry and quietly
 * make these tests lie.
 */
function expiryInDays(days) {
  return formatDate(new Date(Date.now() + days * 86400000));
}

function subscriber(userId, days, { plan = 'monthly' } = {}) {
  db.getOrCreateUser({ id: userId, username: `u${userId}`, firstName: 'U' });
  return db.createSubscription({
    userId,
    plan,
    starsPaid: 300,
    telegramChargeId: `charge-rem-${userId}-${crypto.randomUUID()}`,
    expiresAt: expiryInDays(days),
  });
}

function remindersFor(userId) {
  return db.db
    .prepare('SELECT stage FROM subscription_reminders WHERE user_id = ? ORDER BY stage')
    .all(userId)
    .map((r) => r.stage);
}

function sentTo(userId) {
  return sent.filter((m) => m.chatId === userId);
}

test('each stage fires exactly once, and a retried tick sends nothing further', async () => {
  const userId = 500;
  subscriber(userId, 2); // inside the 3-day window

  await runExpiryReminders(noSleep);
  assert.equal(sentTo(userId).length, 1, 'the 3-day reminder goes out');
  assert.deepEqual(remindersFor(userId), ['expiring_3d']);

  // BullMQ retries a job that threw, and a restart leaves a tick unfinished.
  await runExpiryReminders(noSleep);
  await runExpiryReminders(noSleep);
  assert.equal(sentTo(userId).length, 1, 'a retried tick must not re-notify');
});

test('the reminder carries a Renew button that opens the real subscribe flow', async () => {
  const userId = 501;
  subscriber(userId, 1);

  await runExpiryReminders(noSleep);

  const [message] = sentTo(userId);
  assert.ok(message, 'a subscription one day out is reminded');
  const button = message.extra.reply_markup.inline_keyboard[0][0];
  assert.equal(button.callback_data, 'renew:open');
  assert.equal(message.extra.parse_mode, 'Markdown');
});

test('the stages do not overlap, so one subscription is never caught twice on a tick', async () => {
  const threeDays = 502;
  const oneDay = 503;
  const lapsed = 504;
  subscriber(threeDays, 2);
  subscriber(oneDay, 0.5);
  subscriber(lapsed, -0.5);

  await runExpiryReminders(noSleep);

  assert.deepEqual(remindersFor(threeDays), ['expiring_3d']);
  assert.deepEqual(remindersFor(oneDay), ['expiring_1d']);
  assert.deepEqual(remindersFor(lapsed), ['expired']);
  for (const userId of [threeDays, oneDay, lapsed]) {
    assert.equal(sentTo(userId).length, 1);
  }
});

test('a long-lapsed subscription is left alone, so a first deploy does not spam history', async () => {
  const userId = 505;
  subscriber(userId, -40);

  await runExpiryReminders(noSleep);

  assert.equal(sentTo(userId).length, 0, 'nobody wants a "you lapsed" DM about last month');
  assert.deepEqual(remindersFor(userId), []);
});

test('someone who has already renewed is not reminded about the period they replaced', async () => {
  const userId = 506;
  subscriber(userId, 2); // the old period, days from running out
  subscriber(userId, 32); // and the renewal they have already bought

  await runExpiryReminders(noSleep);

  assert.equal(sentTo(userId).length, 0, 'the short row is not the one deciding their access');
});

test('a comped subscription with no expiry is never reminded about', async () => {
  const userId = 507;
  db.getOrCreateUser({ id: userId, username: 'comped', firstName: 'C' });
  // A grant: no charge id, and no end date to warn anyone about.
  db.createSubscription({ userId, plan: 'monthly', starsPaid: 0, expiresAt: null });

  await runExpiryReminders(noSleep);

  assert.equal(sentTo(userId).length, 0);
  assert.deepEqual(remindersFor(userId), []);
});

test('a user who blocked the bot is not retried every hour for the rest of the window', async () => {
  const userId = 508;
  subscriber(userId, 2);
  sendScript.set(userId, [telegramError(403, 'Forbidden: bot was blocked by the user')]);

  await runExpiryReminders(noSleep);

  assert.equal(sentTo(userId).length, 0, 'it never arrived');
  assert.deepEqual(remindersFor(userId), ['expiring_3d'], 'but it is recorded as dealt with');

  // The next tick, and every tick after it, must leave them alone.
  await runExpiryReminders(noSleep);
  assert.equal(sentTo(userId).length, 0);
});

test('a failed send stays retryable rather than being marked as delivered', async () => {
  const userId = 509;
  subscriber(userId, 2);
  // A transient failure, exhausting the sender's bounded retries.
  sendScript.set(userId, [new Error('socket hang up'), new Error('socket hang up'), new Error('socket hang up')]);

  await runExpiryReminders(noSleep);
  assert.deepEqual(remindersFor(userId), [], 'nothing was delivered, so nothing is recorded');

  // With the network back, the next tick delivers it.
  await runExpiryReminders(noSleep);
  assert.equal(sentTo(userId).length, 1);
  assert.deepEqual(remindersFor(userId), ['expiring_3d']);
});

test('the lapse notice says what the free plan actually is, from the constants', async () => {
  const userId = 510;
  subscriber(userId, -0.5);

  await runExpiryReminders(noSleep);

  const [message] = sentTo(userId);
  assert.ok(message);
  assert.match(message.text, new RegExp(`${FREE_LIMITS.maxSummariesPerDay} summaries a day`));
  assert.ok(!message.text.includes('{'), 'no placeholder was left unfilled');
  assert.ok(!message.text.includes('Infinity'));
});

test('a renewal soon after a reminder is attributable to it', async () => {
  const userId = 511;
  subscriber(userId, 2);
  await runExpiryReminders(noSleep);

  const { RENEWAL_ATTRIBUTION_DAYS } = require('../src/models/subscription');
  assert.equal(db.hasRecentReminder(userId, RENEWAL_ATTRIBUTION_DAYS), true);
  assert.equal(db.hasRecentReminder(999999, RENEWAL_ATTRIBUTION_DAYS), false);

  // An old nudge must not take credit for an unrelated purchase months later.
  db.db.prepare("UPDATE subscription_reminders SET sent_at = datetime('now', '-30 days') WHERE user_id = ?").run(userId);
  assert.equal(db.hasRecentReminder(userId, RENEWAL_ATTRIBUTION_DAYS), false);
});
