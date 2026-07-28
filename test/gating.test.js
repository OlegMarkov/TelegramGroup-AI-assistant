const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-gating-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

const deepseek = require('../src/services/deepseek');
deepseek.summarize = async () => 'stub summary';

const db = require('../src/services/database');
const registerSummary = require('../src/commands/summary');
const registerFind = require('../src/commands/find');
const registerDigest = require('../src/commands/digest');

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
registerFind(fakeBot);
registerDigest(fakeBot);

function makeCtx({ chat, from, subscription, text }) {
  const replies = [];
  return {
    chat,
    from,
    state: { subscription: subscription || null },
    message: { text, message_id: Math.floor(Math.random() * 1e6), date: Math.floor(Date.now() / 1000) },
    replies,
    reply: async (msg) => {
      replies.push(msg);
      return { message_id: 1 };
    },
    editMessageText: async (msg) => {
      replies.push(msg);
    },
    answerCbQuery: async (msg) => {
      replies.push(msg || '');
    },
  };
}

async function fireCallback(callbackData, ctxOpts) {
  for (const { pattern, fn } of handlers.actions) {
    const match = pattern.exec(callbackData);
    if (match) {
      const ctx = makeCtx(ctxOpts);
      ctx.match = match;
      await fn(ctx);
      return ctx;
    }
  }
  throw new Error(`no handler matched callback_data "${callbackData}"`);
}

test.after(() => {
  db.db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

test('free user is blocked after the daily /summary limit', async () => {
  const user = { id: 200, username: 'free', first_name: 'Free' };
  const chat = { id: -200, title: 'G', type: 'supergroup' };
  db.getOrCreateUser({ id: user.id, username: user.username, firstName: user.first_name });
  db.getOrCreateChat({ id: chat.id, title: chat.title, type: chat.type });
  db.linkUserToChat(chat.id, user.id);
  db.saveMessage({ chatId: chat.id, messageId: 1, userId: user.id, username: 'free', text: 'hello' });

  for (let i = 0; i < 3; i++) {
    const ctx = makeCtx({ chat, from: user, text: '/summary' });
    await handlers.commands.summary(ctx);
    assert.ok(
      ctx.replies.some((r) => r.startsWith('📝')),
      `call ${i + 1} of 3 should succeed`
    );
  }

  const blockedCtx = makeCtx({ chat, from: user, text: '/summary' });
  await handlers.commands.summary(blockedCtx);
  assert.ok(blockedCtx.replies.some((r) => r.includes('used your 3 free summaries')));
});

test('free user lookback is capped at 24h; premium at 72h', async () => {
  const freeUser = { id: 201, username: 'free2', first_name: 'F2' };
  const chat = { id: -201, title: 'G2', type: 'supergroup' };
  db.getOrCreateUser({ id: freeUser.id, username: freeUser.username, firstName: freeUser.first_name });
  db.getOrCreateChat({ id: chat.id, title: chat.title, type: chat.type });
  db.linkUserToChat(chat.id, freeUser.id);
  db.saveMessage({ chatId: chat.id, messageId: 1, userId: freeUser.id, username: 'free2', text: 'hi' });

  const ctx = makeCtx({ chat, from: freeUser, text: '/summary 100' });
  await handlers.commands.summary(ctx);
  assert.ok(ctx.replies.some((r) => r.includes('last 24h')));
  assert.ok(ctx.replies.some((r) => r.includes('capped to 24h on the free plan')));
});

test('free user is blocked from a second group but allowed in their first', async () => {
  const user = { id: 202, username: 'free3', first_name: 'F3' };
  const chatA = { id: -202, title: 'First', type: 'supergroup' };
  const chatB = { id: -203, title: 'Second', type: 'supergroup' };

  db.getOrCreateUser({ id: user.id, username: user.username, firstName: user.first_name });
  db.getOrCreateChat({ id: chatA.id, title: chatA.title, type: chatA.type });
  db.getOrCreateChat({ id: chatB.id, title: chatB.title, type: chatB.type });
  db.linkUserToChat(chatA.id, user.id);
  db.db
    .prepare('UPDATE chat_members SET joined_at = ? WHERE chat_id = ? AND user_id = ?')
    .run('2020-01-01 00:00:00', chatA.id, user.id);
  db.linkUserToChat(chatB.id, user.id);
  db.db
    .prepare('UPDATE chat_members SET joined_at = ? WHERE chat_id = ? AND user_id = ?')
    .run('2020-01-02 00:00:00', chatB.id, user.id);
  db.saveMessage({ chatId: chatA.id, messageId: 1, userId: user.id, username: 'free3', text: 'hi A' });

  const okCtx = makeCtx({ chat: chatA, from: user, text: '/summary' });
  await handlers.commands.summary(okCtx);
  assert.ok(okCtx.replies.some((r) => r.startsWith('📝')));

  const blockedCtx = makeCtx({ chat: chatB, from: user, text: '/summary' });
  await handlers.commands.summary(blockedCtx);
  assert.ok(blockedCtx.replies.some((r) => r.includes('first 1 group')));

  const findBlockedCtx = makeCtx({ chat: chatB, from: user, text: '/find hi' });
  await handlers.commands.find(findBlockedCtx);
  assert.ok(findBlockedCtx.replies.some((r) => r.includes('first 1 group')));
});

test('/digest is blocked for free users and works for premium', async () => {
  const freeUser = { id: 203, username: 'free4', first_name: 'F4' };
  const premUser = { id: 204, username: 'prem', first_name: 'P' };
  const chat = { id: -204, title: 'G4', type: 'supergroup' };

  db.getOrCreateUser({ id: freeUser.id, username: freeUser.username, firstName: freeUser.first_name });
  db.getOrCreateUser({ id: premUser.id, username: premUser.username, firstName: premUser.first_name });
  db.getOrCreateChat({ id: chat.id, title: chat.title, type: chat.type });
  db.linkUserToChat(chat.id, freeUser.id);
  db.linkUserToChat(chat.id, premUser.id);
  const sub = db.createSubscription({
    userId: premUser.id,
    plan: 'monthly',
    starsPaid: 150,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });

  const freeCtx = makeCtx({ chat, from: freeUser, text: '/digest' });
  await handlers.commands.digest(freeCtx);
  assert.ok(freeCtx.replies.some((r) => r.includes('premium feature')));

  const premCtx = makeCtx({ chat, from: premUser, subscription: sub, text: '/digest' });
  await handlers.commands.digest(premCtx);
  assert.ok(premCtx.replies.some((r) => r.includes('Daily digest is')));
});

test('summary callback rejects a forged chat id the user is not linked to', async () => {
  const user = { id: 205, username: 'outsider', first_name: 'O' };
  db.getOrCreateUser({ id: user.id, username: user.username, firstName: user.first_name });

  const ctx = await fireCallback('summary:chat:-999999:24', {
    chat: { id: user.id, type: 'private' },
    from: user,
  });
  assert.ok(ctx.replies.some((r) => r.includes('Not authorized')));
});
