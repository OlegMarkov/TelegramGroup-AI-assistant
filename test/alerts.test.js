const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-alerts-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

const db = require('../src/services/database');
const alerts = require('../src/services/keywordAlerts');
const ingestion = require('../src/middleware/ingestion');
const { formatDate } = require('../src/utils/formatters');

const sent = [];
const failWith = new Map();

alerts.setAlertSender(async (chatId, text, extra) => {
  const error = failWith.get(chatId);
  if (error) {
    failWith.delete(chatId);
    throw error;
  }
  sent.push({ chatId, text, extra });
  return { message_id: 1 };
});

test.afterEach(() => {
  sent.length = 0;
  failWith.clear();
  db.db.prepare('DELETE FROM alert_usage').run();
});

test.after(() => {
  db.db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

function premium(userId) {
  db.createSubscription({
    userId,
    plan: 'monthly',
    starsPaid: 300,
    telegramChargeId: `charge-alert-${userId}-${crypto.randomUUID()}`,
    expiresAt: formatDate(new Date(Date.now() + 30 * 86400000)),
  });
}

/** A watcher: premium, in the chat, with keywords and alerts switched on. */
function watcher(userId, chatId, keywords, { isPremium = true, enabled = true } = {}) {
  db.getOrCreateUser({ id: userId, username: `u${userId}`, firstName: 'U' });
  db.linkUserToChat(chatId, userId);
  db.setUserFilters(userId, { keywords, categories: [] });
  if (isPremium) premium(userId);
  db.setUserAlertsEnabled(userId, enabled);
  alerts.setSubscribed(userId, enabled);
}

function group(chatId, title = 'The Group', username = null) {
  db.getOrCreateChat({ id: chatId, title, type: 'supergroup' });
  if (username) db.db.prepare('UPDATE chats SET username = ? WHERE id = ?').run(username, chatId);
}

let messageId = 1000;
function say({ chatId, authorId, text, authorName = 'speaker' }) {
  return alerts.alertOnMessage({
    chat: { id: chatId, title: 'The Group', username: null },
    messageId: messageId++,
    authorId,
    authorName,
    text,
  });
}

test('a matching message reaches the person watching for it', async () => {
  group(-2000);
  db.getOrCreateUser({ id: 2001, username: 'author', firstName: 'A' });
  db.linkUserToChat(-2000, 2001);
  watcher(2000, -2000, ['zebra']);

  const count = await say({ chatId: -2000, authorId: 2001, text: 'the zebra escaped again' });

  assert.equal(count, 1);
  assert.equal(sent[0].chatId, 2000);
  assert.match(sent[0].text, /zebra escaped again/);
  assert.match(sent[0].text, /speaker/, 'and says who said it');
});

test('nobody is alerted about their own message', async () => {
  group(-2010);
  watcher(2010, -2010, ['zebra']);

  const count = await say({ chatId: -2010, authorId: 2010, text: 'I saw a zebra' });

  assert.equal(count, 0);
  assert.deepEqual(sent, [], 'you were there when you wrote it');
});

test('alerts are off until someone turns them on', async () => {
  group(-2020);
  db.getOrCreateUser({ id: 2021, firstName: 'A' });
  db.linkUserToChat(-2020, 2021);
  watcher(2020, -2020, ['zebra'], { enabled: false });

  assert.equal(await say({ chatId: -2020, authorId: 2021, text: 'a zebra' }), 0);

  // And on once they do.
  db.setUserAlertsEnabled(2020, true);
  alerts.setSubscribed(2020, true);
  assert.equal(await say({ chatId: -2020, authorId: 2021, text: 'a zebra' }), 1);
});

test('a lapsed subscriber stops being alerted, and keeps everything they set up', async () => {
  group(-2030);
  db.getOrCreateUser({ id: 2031, firstName: 'A' });
  db.linkUserToChat(-2030, 2031);
  watcher(2030, -2030, ['zebra'], { isPremium: false });

  assert.equal(await say({ chatId: -2030, authorId: 2031, text: 'a zebra' }), 0, 'premium-gated');

  // Their opt-in and their keywords are untouched — they simply resume.
  assert.equal(db.getUserFilters(2030).keywords.length, 1);
  assert.equal(alerts.isSubscribed(2030), true);

  premium(2030);
  assert.equal(await say({ chatId: -2030, authorId: 2031, text: 'a zebra' }), 1);
});

test('the keyword allowance is applied on the way out, not at the screen', async () => {
  // Same rule digest.js follows, for the same reason: a subscription can lapse
  // between adding a keyword and a message arriving.
  group(-2040);
  db.getOrCreateUser({ id: 2041, firstName: 'A' });
  db.linkUserToChat(-2040, 2041);
  watcher(2040, -2040, ['zebra', 'walrus', 'penguin']);

  // On premium all three are live.
  assert.equal(await say({ chatId: -2040, authorId: 2041, text: 'a walrus appeared' }), 1);

  // Lapsed: free allows one, and "earliest N wins" makes it the first.
  db.revokeActiveSubscriptions(2040);
  sent.length = 0;
  assert.equal(await say({ chatId: -2040, authorId: 2041, text: 'a walrus appeared' }), 0);
});

test('someone not in the chat is never alerted about it', async () => {
  group(-2050);
  group(-2051);
  db.getOrCreateUser({ id: 2052, firstName: 'A' });
  db.linkUserToChat(-2050, 2052);
  // Watching in a different group entirely.
  watcher(2050, -2051, ['zebra']);

  assert.equal(await say({ chatId: -2050, authorId: 2052, text: 'a zebra' }), 0);
});

test('the hourly cap stops one busy keyword becoming a hundred DMs', async () => {
  group(-2060);
  db.getOrCreateUser({ id: 2061, firstName: 'A' });
  db.linkUserToChat(-2060, 2061);
  watcher(2060, -2060, ['zebra']);

  const max = alerts.MAX_ALERTS_PER_HOUR;
  for (let i = 0; i < max; i++) {
    assert.equal(await say({ chatId: -2060, authorId: 2061, text: `zebra number ${i}` }), 1);
  }
  assert.equal(sent.length, max);

  // The one over the line explains the silence...
  await say({ chatId: -2060, authorId: 2061, text: 'zebra again' });
  assert.equal(sent.length, max + 1);
  assert.match(sent[max].text, /hold the rest/);

  // ...and everything after it is silent.
  for (let i = 0; i < 5; i++) await say({ chatId: -2060, authorId: 2061, text: 'zebra once more' });
  assert.equal(sent.length, max + 1, 'no further messages this hour');

  // The suppressed ones are counted, so the noise is measurable.
  const hourKey = new Date().toISOString().slice(0, 13);
  const row = db.db.prepare('SELECT sent, suppressed FROM alert_usage WHERE user_id = ? AND hour_key = ?').get(2060, hourKey);
  assert.equal(row.sent, max);
  assert.equal(row.suppressed, 6);
});

test('the cap rolls over with the hour, on its own', async () => {
  group(-2070);
  db.getOrCreateUser({ id: 2071, firstName: 'A' });
  db.linkUserToChat(-2070, 2071);
  watcher(2070, -2070, ['zebra']);

  for (let i = 0; i <= alerts.MAX_ALERTS_PER_HOUR; i++) {
    await say({ chatId: -2070, authorId: 2071, text: 'zebra' });
  }
  sent.length = 0;

  // What the next hour looks like: this hour's row is simply not the one read.
  const hourKey = new Date().toISOString().slice(0, 13);
  db.db.prepare("UPDATE alert_usage SET hour_key = '2000-01-01T00' WHERE user_id = ? AND hour_key = ?").run(2070, hourKey);

  assert.equal(await say({ chatId: -2070, authorId: 2071, text: 'zebra' }), 1, 'a new hour starts fresh');
});

test('quoted text is escaped, because a stranger wrote it', async () => {
  group(-2080);
  db.getOrCreateUser({ id: 2081, firstName: 'A' });
  db.linkUserToChat(-2080, 2081);
  watcher(2080, -2080, ['zebra']);

  await say({
    chatId: -2080,
    authorId: 2081,
    authorName: 'a*b_c',
    text: 'zebra [click](http://evil.example) *bold*',
  });

  // Unescaped, that renders as a link the reader has every reason to think
  // came from the bot.
  assert.match(sent[0].text, /\\\[click\\\]/);
  assert.match(sent[0].text, /a\\\*b\\_c/);
});

test('a user who blocked the bot has their alerts switched off', async () => {
  group(-2090);
  db.getOrCreateUser({ id: 2091, firstName: 'A' });
  db.linkUserToChat(-2090, 2091);
  watcher(2090, -2090, ['zebra']);

  const blocked = new Error('403: Forbidden: bot was blocked by the user');
  blocked.code = 403;
  blocked.response = { error_code: 403, description: 'Forbidden: bot was blocked by the user' };
  failWith.set(2090, blocked);

  await say({ chatId: -2090, authorId: 2091, text: 'a zebra' });

  assert.equal(alerts.isSubscribed(2090), false, 'retrying for ever is the waste case-11 removed');
  assert.equal(db.db.prepare('SELECT alerts_enabled FROM users WHERE id = ?').get(2090).alerts_enabled, 0);
});

test('a message link is built for a public group and for a private supergroup', () => {
  assert.equal(
    alerts.messageLink({ id: -1001234567890, username: 'mygroup' }, 42),
    'https://t.me/mygroup/42'
  );
  assert.equal(
    alerts.messageLink({ id: -1001234567890, username: null }, 42),
    'https://t.me/c/1234567890/42',
    'works for anyone already in the chat, which the recipient is'
  );
  // A legacy group has no permalink shape at all: no link beats a broken one.
  assert.equal(alerts.messageLink({ id: -12345, username: null }, 42), null);
});

test('nobody watching costs one lookup and nothing else', async () => {
  // The reason this is affordable on the hot path of every group message.
  alerts.reload();
  db.db.prepare('UPDATE users SET alerts_enabled = 0').run();
  alerts.reload();

  group(-2100);
  db.getOrCreateUser({ id: 2101, firstName: 'A' });
  db.linkUserToChat(-2100, 2101);

  assert.equal(await say({ chatId: -2100, authorId: 2101, text: 'zebra walrus penguin' }), 0);
  assert.deepEqual(sent, []);
});

test('ingestion hands a stored message to the alerter without waiting for it', async () => {
  alerts.reload();
  group(-2110);
  db.getOrCreateUser({ id: 2111, username: 'author', firstName: 'A' });
  db.linkUserToChat(-2110, 2111);
  watcher(2110, -2110, ['zebra']);

  const middleware = ingestion();
  let handedOn = false;

  await middleware(
    {
      chat: { id: -2110, title: 'The Group', type: 'supergroup' },
      from: { id: 2111, username: 'author', is_bot: false },
      message: { message_id: 9001, text: 'the zebra is loose', date: Math.floor(Date.now() / 1000) },
      state: {},
    },
    async () => {
      handedOn = true;
    }
  );

  assert.equal(handedOn, true, 'the update is passed on immediately, not after a DM');

  // The alert arrives on its own, shortly after.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /zebra is loose/);
});
