const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-ask-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';
// Set before config is loaded: it reads the environment once, at require time.
process.env.DEEPSEEK_DAILY_WARN_COMPLETIONS = '1000';
process.env.DEEPSEEK_DAILY_MAX_COMPLETIONS = '3';

const db = require('../src/services/database');
const budget = require('../src/services/aiBudget');
const deepseek = require('../src/services/deepseek');
const ingestionPolicy = require('../src/services/ingestionPolicy');
const { EVENTS } = require('../src/services/analytics');
const { MAX_QUESTION_CHARS } = require('../src/commands/ask');
const registerAsk = require('../src/commands/ask');

// Stubbed on the exported client instance, exactly like aiBudget.test.js:
// axios.create() binds its methods, so a prototype patch would not intercept
// this call, and an unstubbed call would hit a guaranteed-closed port.
const calls = [];
deepseek.client.post = async (url, body) => {
  calls.push({ url, body });
  return {
    data: {
      choices: [{ message: { content: 'Stub answer.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    },
  };
};

const handlers = { commands: {}, actions: [] };
registerAsk({
  command(name, fn) {
    handlers.commands[name] = fn;
  },
  hears() {},
  action(pattern, fn) {
    handlers.actions.push({ pattern, fn });
  },
});

const PREMIUM = { plan: 'monthly', status: 'active' };

function makeCtx({ chat, from, subscription, text }) {
  const replies = [];
  return {
    chat,
    from,
    state: { lang: 'en', subscription: subscription || null },
    message: { text, message_id: Math.floor(Math.random() * 1e6), date: Math.floor(Date.now() / 1000) },
    replies,
    reply: async (msg, extra) => {
      replies.push({ msg, extra: extra || {} });
      return { message_id: 1 };
    },
    answerCbQuery: async (msg) => {
      replies.push({ msg: msg || '', extra: {}, answer: true });
    },
  };
}

function matchAction(pattern, data) {
  return pattern.exec(data);
}

async function fireCallback(data, opts) {
  for (const { pattern, fn } of handlers.actions) {
    const match = matchAction(pattern, data);
    if (match) {
      const ctx = makeCtx(opts);
      ctx.match = match;
      await fn(ctx);
      return ctx;
    }
  }
  throw new Error(`no handler matched ${data}`);
}

let nextId = 8000;
function seedChat(title) {
  const userId = (nextId += 1);
  const chatId = -(nextId + 5000);
  db.getOrCreateUser({ id: userId, username: `u${userId}`, firstName: 'U' });
  db.getOrCreateChat({ id: chatId, title, type: 'supergroup' });
  db.linkUserToChat(chatId, userId);
  db.saveMessage({ chatId, messageId: 1, userId, username: `u${userId}`, text: 'The venue is confirmed for Friday.' });
  return { userId, chatId };
}

function eventCount(type, userId) {
  return db.db.prepare('SELECT COUNT(*) c FROM events WHERE event_type = ? AND user_id = ?').get(type, userId).c;
}

test.afterEach(() => {
  budget.resetToday();
});

test.after(() => {
  db.db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

test('a free user is refused with a paywall reply, and it is counted', async () => {
  const { userId, chatId } = seedChat('FreeAsk');
  const before = calls.length;

  const ctx = makeCtx({ chat: { id: chatId, type: 'supergroup' }, from: { id: userId }, text: '/ask what is happening?' });
  await handlers.commands.ask(ctx);

  assert.match(ctx.replies[0].msg, /premium/i);
  assert.equal(eventCount(EVENTS.ASK_BLOCKED_PREMIUM, userId), 1);
  assert.equal(eventCount(EVENTS.ASK_REQUESTED, userId), 1, 'the attempt is still logged as a request');
  assert.equal(calls.length, before, 'no AI call is made for a blocked question');
});

test('premium in a group answers from that group; the question sits outside the fence and the chat inside it', async () => {
  const { userId, chatId } = seedChat('GroupAsk');
  const question = 'What did we decide about the venue?';

  const ctx = makeCtx({ chat: { id: chatId, type: 'supergroup' }, from: { id: userId }, subscription: PREMIUM, text: `/ask ${question}` });
  const before = calls.length;
  await handlers.commands.ask(ctx);

  assert.equal(calls.length, before + 1, 'exactly one AI call was made');
  const { body } = calls[calls.length - 1];
  const userMessage = body.messages.find((m) => m.role === 'user').content;

  const openIdx = userMessage.indexOf('<content>');
  const closeIdx = userMessage.indexOf('</content>');
  const questionIdx = userMessage.indexOf(`Question: ${question}`);

  assert.ok(openIdx >= 0 && closeIdx > openIdx, 'the transcript is fenced');
  assert.ok(questionIdx > closeIdx, 'the question sits outside (after) the fence');
  assert.ok(
    userMessage.slice(openIdx, closeIdx).includes('The venue is confirmed for Friday.'),
    'the chat transcript is inside the fence'
  );
  assert.ok(!userMessage.slice(0, openIdx).includes(question), 'the question is not duplicated before the fence');

  assert.equal(eventCount(EVENTS.ASK_ANSWERED, userId), 1);
  assert.match(ctx.replies[0].msg, /Stub answer\./);
  assert.deepEqual(ctx.replies[0].extra.link_preview_options, { is_disabled: true });
});

test('a question over the character limit is rejected before anything else', async () => {
  const { userId, chatId } = seedChat('TooLong');
  const question = 'x'.repeat(MAX_QUESTION_CHARS + 1);
  const before = calls.length;

  const ctx = makeCtx({ chat: { id: chatId, type: 'supergroup' }, from: { id: userId }, subscription: PREMIUM, text: `/ask ${question}` });
  await handlers.commands.ask(ctx);

  assert.match(ctx.replies[0].msg, new RegExp(String(MAX_QUESTION_CHARS)));
  assert.equal(calls.length, before);
  assert.equal(eventCount(EVENTS.ASK_REQUESTED, userId), 0, 'too long is refused before being logged as a request');
});

test('the daily cap of 30 is enforced, and refused before spending an AI call', async () => {
  const { userId, chatId } = seedChat('DailyCap');
  for (let i = 0; i < 30; i += 1) db.incrementAskUsage(userId);

  const before = calls.length;
  const ctx = makeCtx({ chat: { id: chatId, type: 'supergroup' }, from: { id: userId }, subscription: PREMIUM, text: '/ask one more?' });
  await handlers.commands.ask(ctx);

  assert.match(ctx.replies[0].msg, /30/);
  assert.equal(eventCount(EVENTS.ASK_BLOCKED_DAILY_LIMIT, userId), 1);
  assert.equal(calls.length, before, 'the cap is checked before any AI call is made');
});

test('a spend-cap error refuses the answer and does not count against the daily allowance', async () => {
  const { userId, chatId } = seedChat('SpendCap');
  for (let i = 0; i < 3; i += 1) budget.recordCompletion();

  const before = calls.length;
  const beforeUsage = db.getAskUsageToday(userId);
  const ctx = makeCtx({ chat: { id: chatId, type: 'supergroup' }, from: { id: userId }, subscription: PREMIUM, text: '/ask anything?' });
  await handlers.commands.ask(ctx);

  assert.match(ctx.replies[0].msg, /daily limit/i);
  assert.equal(calls.length, before, 'the request is never sent once the cap is reached');
  assert.equal(db.getAskUsageToday(userId), beforeUsage, 'nothing was answered, so nothing is charged');
});

test('a paused chat is refused, like /summary', async () => {
  const { userId, chatId } = seedChat('Paused');
  ingestionPolicy.pauseChat(chatId, true);
  try {
    const ctx = makeCtx({ chat: { id: chatId, type: 'supergroup' }, from: { id: userId }, subscription: PREMIUM, text: '/ask anything?' });
    await handlers.commands.ask(ctx);
    assert.match(ctx.replies[0].msg, /paused/i);
  } finally {
    ingestionPolicy.pauseChat(chatId, false);
  }
});

test('a DM with several linked chats offers a picker, and the callback answers from the right one', async () => {
  const userId = (nextId += 1);
  const chatA = { id: -(nextId + 6000), title: 'PickerA' };
  const chatB = { id: -(nextId + 6001), title: 'PickerB' };
  db.getOrCreateUser({ id: userId, username: `u${userId}`, firstName: 'U' });
  const sub = db.createSubscription({
    userId,
    plan: 'monthly',
    starsPaid: 300,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  for (const c of [chatA, chatB]) {
    db.getOrCreateChat({ id: c.id, title: c.title, type: 'supergroup' });
    db.linkUserToChat(c.id, userId);
  }
  db.saveMessage({ chatId: chatB.id, messageId: 1, userId, username: `u${userId}`, text: 'the roadmap for Q3' });

  const question = 'what is the plan for Q3?';
  const ctx = makeCtx({ chat: { id: userId, type: 'private' }, from: { id: userId }, subscription: sub, text: `/ask ${question}` });
  await handlers.commands.ask(ctx);

  const markup = ctx.replies[0].extra.reply_markup;
  const data = markup.inline_keyboard.map(([b]) => b.callback_data);
  const target = data.find((d) => d.includes(String(chatB.id)));
  assert.ok(target, 'a button exists for the chat with the matching content');
  assert.match(target, /^ask:chat:-?\d+:[0-9a-f]{8}$/);

  const before = calls.length;
  const answered = await fireCallback(target, { chat: { id: userId, type: 'private' }, from: { id: userId }, subscription: sub });
  assert.equal(calls.length, before + 1);
  assert.match(answered.replies[answered.replies.length - 1].msg, /Stub answer\./);

  // Another user tapping the same button gets nowhere.
  const strangerId = (nextId += 1);
  db.getOrCreateUser({ id: strangerId, username: `u${strangerId}`, firstName: 'S' });
  const stranger = await fireCallback(target, { chat: { id: strangerId, type: 'private' }, from: { id: strangerId }, subscription: sub });
  assert.match(stranger.replies[0].msg, /expired/i);

  // An unknown token behaves the same way.
  const bogus = await fireCallback(`ask:chat:${chatA.id}:${'0'.repeat(8)}`, {
    chat: { id: userId, type: 'private' },
    from: { id: userId },
    subscription: sub,
  });
  assert.match(bogus.replies[0].msg, /expired/i);
});

test('the transcript is bounded by maxLookbackHours (72h for premium): older messages are left out', async () => {
  const { userId, chatId } = seedChat('WindowBound');
  db.saveMessage({
    chatId,
    messageId: 2,
    userId,
    username: `u${userId}`,
    text: 'ancient-history-fragment from four days ago',
    createdAt: new Date(Date.now() - 96 * 3600 * 1000).toISOString(), // 96h ago > 72h premium cap
  });
  db.saveMessage({
    chatId,
    messageId: 3,
    userId,
    username: `u${userId}`,
    text: 'recent-fragment from this morning',
    createdAt: new Date(Date.now() - 1 * 3600 * 1000).toISOString(),
  });

  const ctx = makeCtx({ chat: { id: chatId, type: 'supergroup' }, from: { id: userId }, subscription: PREMIUM, text: '/ask what happened?' });
  await handlers.commands.ask(ctx);

  const { body } = calls[calls.length - 1];
  const userMessage = body.messages.find((m) => m.role === 'user').content;
  assert.match(userMessage, /recent-fragment from this morning/);
  assert.doesNotMatch(userMessage, /ancient-history-fragment/, 'a message older than the lookback window must not reach the model');
});
