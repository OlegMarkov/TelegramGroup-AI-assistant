const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-summary-week-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

const deepseek = require('../src/services/deepseek');
deepseek.summarize = async () => 'stub summary';

const db = require('../src/services/database');
const { parseHours } = require('../src/commands/summary');
const registerSummary = require('../src/commands/summary');
const { EVENTS } = require('../src/services/analytics');

const handlers = { commands: {}, actions: [] };
const fakeBot = {
  command(name, fn) {
    handlers.commands[name] = fn;
  },
  hears() {},
  action(pattern, fn) {
    handlers.actions.push({ pattern, fn });
  },
};
registerSummary(fakeBot);

const PREMIUM = { plan: 'monthly', status: 'active' };

function makeCtx({ chat, from, subscription, text }) {
  const replies = [];
  return {
    chat,
    from,
    state: { subscription: subscription || null },
    message: { text, message_id: Math.floor(Math.random() * 1e6), date: Math.floor(Date.now() / 1000) },
    replies,
    reply: async (msg, extra) => {
      replies.push({ msg, extra: extra || {} });
      return { message_id: 1 };
    },
    editMessageText: async (msg) => {
      replies.push({ msg, extra: {} });
    },
    answerCbQuery: async (msg) => {
      replies.push({ msg: msg || '', extra: {}, answer: true });
    },
  };
}

function lastMsg(ctx) {
  return ctx.replies.map((r) => r.msg);
}

function header(ctx) {
  return ctx.replies.find((r) => r.msg && r.msg.startsWith('📝'));
}

let nextId = 900;
function seedUserInChat(chatTitle) {
  const user = { id: (nextId += 1), username: `u${nextId}`, first_name: 'U' };
  const chat = { id: -(nextId + 2000), title: chatTitle, type: 'supergroup' };
  db.getOrCreateUser({ id: user.id, username: user.username, firstName: user.first_name });
  db.getOrCreateChat({ id: chat.id, title: chat.title, type: chat.type });
  db.linkUserToChat(chat.id, user.id);
  db.saveMessage({ chatId: chat.id, messageId: 1, userId: user.id, username: user.username, text: 'hello there' });
  return { user, chat };
}

function lastEventMetadata(userId, type) {
  const row = db.db
    .prepare('SELECT metadata FROM events WHERE user_id = ? AND event_type = ? ORDER BY id DESC LIMIT 1')
    .get(userId, type);
  return row && (row.metadata ? JSON.parse(row.metadata) : null);
}

test.after(() => {
  db.db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

test('parseHours recognizes "week" and its Russian spellings', () => {
  assert.equal(parseHours(['week']), 'week');
  assert.equal(parseHours(['Week']), 'week', 'case-insensitive');
  assert.equal(parseHours(['неделя']), 'week');
  assert.equal(parseHours(['неделю']), 'week');
  assert.equal(parseHours(['12']), 12, 'an ordinary number is unaffected');
});

test('a premium /summary week covers 168h and says so in the header, unclamped', async () => {
  const { user, chat } = seedUserInChat('WeekPremium');

  const ctx = makeCtx({ chat, from: user, subscription: PREMIUM, text: '/summary week' });
  await handlers.commands.summary(ctx);

  const h = header(ctx);
  assert.ok(h, 'a summary should have been delivered');
  assert.match(h.msg, /last 168h/);
  assert.match(h.msg, /the past week/i, 'the week note explains the unusual number');
});

test('a free user is refused, told about premium, and the daily allowance is untouched', async () => {
  const { user, chat } = seedUserInChat('WeekFree');

  const before = db.getSummaryUsageToday(user.id);
  const ctx = makeCtx({ chat, from: user, text: '/summary week' });
  await handlers.commands.summary(ctx);

  assert.equal(db.getSummaryUsageToday(user.id), before, 'a blocked request must not spend a free summary');
  assert.ok(
    ctx.replies.some((r) => /premium/i.test(r.msg)),
    'the free user is told this needs premium'
  );
  assert.equal(
    db.db.prepare('SELECT COUNT(*) c FROM events WHERE user_id = ? AND event_type = ?')
      .get(user.id, EVENTS.SUMMARY_WEEK_BLOCKED_PREMIUM).c,
    1
  );
  // No summary was produced at all.
  assert.ok(!header(ctx), 'a blocked request never reaches the summary itself');
});

test('/summary 168 is still clamped to the 72h premium ceiling', async () => {
  const { user, chat } = seedUserInChat('Clamped168');

  const ctx = makeCtx({ chat, from: user, subscription: PREMIUM, text: '/summary 168' });
  await handlers.commands.summary(ctx);

  const h = header(ctx);
  assert.match(h.msg, /last 72h/, 'the numeric path stays capped; only the word "week" is exempt');
});

test('summary_requested logs what was actually typed, before the clamp', async () => {
  const { user, chat } = seedUserInChat('Logged');

  const ctx = makeCtx({ chat, from: user, subscription: PREMIUM, text: '/summary 168' });
  await handlers.commands.summary(ctx);

  const metadata = lastEventMetadata(user.id, EVENTS.SUMMARY_REQUESTED);
  assert.deepEqual(metadata, { auto: false, requested: 168 });
});

test('summary_requested records null for an automatic (argument-less) request', async () => {
  const { user, chat } = seedUserInChat('LoggedAuto');

  const ctx = makeCtx({ chat, from: user, text: '/summary' });
  await handlers.commands.summary(ctx);

  const metadata = lastEventMetadata(user.id, EVENTS.SUMMARY_REQUESTED);
  assert.deepEqual(metadata, { auto: true, requested: null });
});

test('the DM picker\'s week option round-trips through summary:chat:<id>:week', async () => {
  const user = { id: (nextId += 1), username: 'picker', first_name: 'P' };
  const chatA = { id: -(nextId + 3000), title: 'PA', type: 'supergroup' };
  const chatB = { id: -(nextId + 3001), title: 'PB', type: 'supergroup' };
  db.getOrCreateUser({ id: user.id, username: user.username, firstName: user.first_name });
  const sub = db.createSubscription({
    userId: user.id,
    plan: 'monthly',
    starsPaid: 300,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  for (const c of [chatA, chatB]) {
    db.getOrCreateChat({ id: c.id, title: c.title, type: c.type });
    db.linkUserToChat(c.id, user.id);
  }
  db.saveMessage({ chatId: chatB.id, messageId: 1, userId: user.id, username: 'picker', text: 'week please' });

  const privateChat = { id: user.id, type: 'private' };
  const pickerCtx = makeCtx({ chat: privateChat, from: user, subscription: sub, text: '/summary week' });
  let markup;
  pickerCtx.reply = async (msg, extra) => {
    pickerCtx.replies.push({ msg, extra: extra || {} });
    markup = extra && extra.reply_markup;
    return { message_id: 1 };
  };
  await handlers.commands.summary(pickerCtx);

  const data = markup.inline_keyboard.map(([b]) => b.callback_data);
  assert.ok(data.every((d) => d.endsWith(':week')), `picker must carry "week": ${data.join(', ')}`);

  const target = data.find((d) => d.includes(String(chatB.id)));
  const route = handlers.actions.find(({ pattern }) => pattern.test && pattern.test(target));
  assert.ok(route, `no bot.action() matches ${target}`);

  const cbCtx = makeCtx({ chat: privateChat, from: user, subscription: sub, text: '' });
  cbCtx.match = route.pattern.exec(target);
  await route.fn(cbCtx);

  const h = header(cbCtx);
  assert.match(h.msg, /last 168h/);
});

test('a /summary send disables the link preview', async () => {
  const { user, chat } = seedUserInChat('PreviewOff');

  const ctx = makeCtx({ chat, from: user, text: '/summary' });
  await handlers.commands.summary(ctx);

  const h = header(ctx);
  assert.deepEqual(h.extra.link_preview_options, { is_disabled: true });
});
