const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-referral-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

const deepseek = require('../src/services/deepseek');
deepseek.summarize = async () => 'stub summary';

const db = require('../src/services/database');
const { track, getFunnelReport, EVENTS } = require('../src/services/analytics');
const registerStart = require('../src/commands/start');
const registerSummary = require('../src/commands/summary');

let startHandler;
registerStart({
  start(fn) {
    startHandler = fn;
  },
  command() {},
  hears() {},
  action() {},
});

const summaryHandlers = { commands: {} };
registerSummary({
  command(name, fn) {
    summaryHandlers.commands[name] = fn;
  },
  hears() {},
  action() {},
});

test.after(() => {
  db.db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

function eventRow(userId, type) {
  return db.db
    .prepare('SELECT chat_id, metadata FROM events WHERE user_id = ? AND event_type = ? ORDER BY id DESC LIMIT 1')
    .get(userId, type);
}

// --- /start records referral_started against a group the bot knows -------

function startCtx(userId, text) {
  db.getOrCreateUser({ id: userId, username: `s${userId}`, firstName: 'New' });
  const replies = [];
  return {
    from: { id: userId, first_name: 'New' },
    chat: { id: userId, type: 'private' },
    message: { text },
    state: { lang: 'en', subscription: null },
    replies,
    reply: async (t, extra) => {
      replies.push({ t, extra: extra || {} });
      return { message_id: 1 };
    },
  };
}

test('a /start with a known group\'s referral payload is credited to that group', async () => {
  const userId = 9001;
  const chatId = -100123;
  db.getOrCreateChat({ id: chatId, title: 'Referring group', type: 'supergroup' });

  await startHandler(startCtx(userId, `/start g${chatId}`));

  const row = eventRow(userId, EVENTS.REFERRAL_STARTED);
  assert.ok(row, 'referral_started must be recorded');
  assert.equal(row.chat_id, chatId);
  assert.equal(JSON.parse(row.metadata).firstStart, true, 'a brand-new user also gets a granted trial');
});

test('a returning user through the same link is still credited, but not as a first start', async () => {
  const userId = 9002;
  const chatId = -100124;
  db.getOrCreateChat({ id: chatId, title: 'Second group', type: 'supergroup' });

  // Uses up the once-ever trial, so the second /start below is not a first-timer.
  await startHandler(startCtx(userId, '/start'));
  await startHandler(startCtx(userId, `/start g${chatId}`));

  const row = eventRow(userId, EVENTS.REFERRAL_STARTED);
  assert.ok(row);
  assert.equal(row.chat_id, chatId);
  assert.equal(JSON.parse(row.metadata).firstStart, false);
});

test('an unknown group id records nothing: anyone can edit a link', async () => {
  const userId = 9003;
  await startHandler(startCtx(userId, '/start g-999999999'));
  assert.equal(eventRow(userId, EVENTS.REFERRAL_STARTED), undefined);
});

test('garbage payloads record nothing', async () => {
  for (const [i, payload] of ['gabc', 'g', 'somethingelse', 'g-'].entries()) {
    const userId = 9010 + i;
    await startHandler(startCtx(userId, `/start ${payload}`));
    assert.equal(eventRow(userId, EVENTS.REFERRAL_STARTED), undefined, `payload "${payload}" must not be credited`);
  }
});

test('a channel id is not a group and is never credited', async () => {
  const userId = 9004;
  const channel = db.getOrCreateChannel({ username: 'somechannel', title: 'Some Channel' });

  await startHandler(startCtx(userId, `/start g${channel.id}`));
  assert.equal(eventRow(userId, EVENTS.REFERRAL_STARTED), undefined);
});

test('a plain /start with no payload records no referral', async () => {
  const userId = 9005;
  await startHandler(startCtx(userId, '/start'));
  assert.equal(eventRow(userId, EVENTS.REFERRAL_STARTED), undefined);
});

// --- the summary footer links back to the bot, only where it is useful ---

function summaryCtx({ chat, from, botUsername, subscription }) {
  const replies = [];
  return {
    chat,
    from,
    botInfo: botUsername ? { username: botUsername } : undefined,
    state: { subscription: subscription || null },
    message: { text: '/summary', message_id: 1, date: Math.floor(Date.now() / 1000) },
    replies,
    reply: async (msg) => {
      replies.push(msg);
      return { message_id: 1 };
    },
  };
}

function seedChatWithMessage(chatId, userId, title) {
  db.getOrCreateUser({ id: userId, username: `u${userId}`, firstName: 'U' });
  db.getOrCreateChat({ id: chatId, title, type: 'supergroup' });
  db.linkUserToChat(chatId, userId);
  db.saveMessage({ chatId, messageId: 1, userId, username: `u${userId}`, text: 'something worth summarizing' });
}

test('a summary posted in a group carries a referral link naming that group', async () => {
  const chatId = -9101;
  const userId = 9101;
  seedChatWithMessage(chatId, userId, 'Referral Group');

  const ctx = summaryCtx({ chat: { id: chatId, type: 'supergroup' }, from: { id: userId }, botUsername: 'mysummarybot' });
  await summaryHandlers.commands.summary(ctx);

  const body = ctx.replies.join('\n');
  assert.match(body, new RegExp(`https://t\\.me/mysummarybot\\?start=g${chatId}`));
});

test('a summary read in a DM carries no referral link — its reader already has the bot', async () => {
  const chatId = -9102;
  const userId = 9102;
  seedChatWithMessage(chatId, userId, 'DM Source');

  // Requested from the private chat, the same way the DM picker delivers it.
  const ctx = summaryCtx({ chat: { id: userId, type: 'private' }, from: { id: userId }, botUsername: 'mysummarybot' });
  await summaryHandlers.commands.summary(ctx);

  const body = ctx.replies.join('\n');
  assert.doesNotMatch(body, /\?start=g/);
});

test('without a bot username (only a test lacks one) the footer is unchanged, not broken', async () => {
  const chatId = -9103;
  const userId = 9103;
  seedChatWithMessage(chatId, userId, 'No Username');

  const ctx = summaryCtx({ chat: { id: chatId, type: 'supergroup' }, from: { id: userId }, botUsername: null });
  await summaryHandlers.commands.summary(ctx);

  const body = ctx.replies.join('\n');
  assert.doesNotMatch(body, /\?start=g/);
  assert.match(body, /Summarized by this bot/);
});

// --- the funnel report --------------------------------------------------

test('getFunnelReport reports referred users and how many of them paid', () => {
  // Diffed against a baseline, like the other paywall/trial funnel tests in
  // this suite: earlier tests in this same file already logged some
  // referral_started events of their own, in the same 30-day window.
  const before = getFunnelReport(30);

  db.getOrCreateUser({ id: 9201, username: 'r1', firstName: 'R' }); // referred, converts
  db.getOrCreateUser({ id: 9202, username: 'r2', firstName: 'R' }); // referred, never converts
  db.getOrCreateUser({ id: 9203, username: 'r3', firstName: 'R' }); // purchases, never referred

  track(EVENTS.REFERRAL_STARTED, { userId: 9201, chatId: -9201 });
  track(EVENTS.SUBSCRIPTION_PURCHASED, { userId: 9201, metadata: { plan: 'monthly' } });

  track(EVENTS.REFERRAL_STARTED, { userId: 9202, chatId: -9202 });

  track(EVENTS.SUBSCRIPTION_PURCHASED, { userId: 9203, metadata: { plan: 'yearly' } });

  const report = getFunnelReport(30);
  assert.equal(report.referredUsers - before.referredUsers, 2, 'users 9201 and 9202 both came through a referral');
  assert.equal(
    report.convertedFromReferral - before.convertedFromReferral,
    1,
    'only 9201 both was referred and paid'
  );
});
