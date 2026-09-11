const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-since-last-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

const deepseek = require('../src/services/deepseek');
deepseek.summarize = async () => 'stub summary';

// Wrapped rather than replaced: the window that actually reaches generateDigest
// is the digest cache key, and it is the thing this feature has to keep stable.
// Patched before summary.js is required, because it destructures at load time.
const digest = require('../src/services/digest');
const realGenerateDigest = digest.generateDigest;
const digestCalls = [];
digest.generateDigest = async (chatId, userId, hours, lang) => {
  digestCalls.push({ chatId, userId, hours, lang });
  return realGenerateDigest(chatId, userId, hours, lang);
};

const db = require('../src/services/database');
const { parseHours } = require('../src/commands/summary');
const registerSummary = require('../src/commands/summary');

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

function makeCtx({ chat, from, subscription, text, failSummarySend }) {
  const replies = [];
  return {
    chat,
    from,
    state: { subscription: subscription || null },
    message: { text, message_id: Math.floor(Math.random() * 1e6), date: Math.floor(Date.now() / 1000) },
    replies,
    reply: async (msg) => {
      // Telegram rejecting the delivery itself, both with Markdown and on the
      // plain-text retry — the working/blocked notices still go through.
      if (failSummarySend && msg.startsWith('📝')) throw new Error('Bad Request: message could not be sent');
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

let nextId = 700;
function seedUserInChat(chatTitle) {
  const user = { id: (nextId += 1), username: `u${nextId}`, first_name: 'U' };
  const chat = { id: -(nextId + 1000), title: chatTitle, type: 'supergroup' };
  db.getOrCreateUser({ id: user.id, username: user.username, firstName: user.first_name });
  db.getOrCreateChat({ id: chat.id, title: chat.title, type: chat.type });
  db.linkUserToChat(chat.id, user.id);
  db.saveMessage({ chatId: chat.id, messageId: 1, userId: user.id, username: user.username, text: 'hello there' });
  return { user, chat };
}

// Relative-time modifiers rather than sleeping or arithmetic on Date.now():
// delivered_at is written by SQLite's datetime('now') and read back by
// julianday(), so the fake has to be made the same way the real one is.
function fakeLastRead(userId, chatId, modifier) {
  db.db
    .prepare(
      `INSERT INTO summary_reads (user_id, chat_id, delivered_at) VALUES (?, ?, datetime('now', ?))
       ON CONFLICT(user_id, chat_id) DO UPDATE SET delivered_at = excluded.delivered_at`
    )
    .run(userId, chatId, modifier);
}

function lastDigestCall() {
  return digestCalls[digestCalls.length - 1];
}

test.after(() => {
  db.db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

test('parseHours distinguishes no argument from an explicit one', () => {
  assert.equal(parseHours([]), null, 'no argument must stay unresolved for buildAndSendSummary');
  assert.equal(parseHours(['6']), 6);
  assert.equal(parseHours(['banana']), 24, 'an explicit but unusable number still falls back');
  assert.equal(parseHours(['-3']), 24);
  assert.equal(parseHours(['5000']), 168, 'still bounded by the sanity ceiling');
});

test('a first-ever /summary falls back to 24h and says so', async () => {
  const { user, chat } = seedUserInChat('First');

  const ctx = makeCtx({ chat, from: user, text: '/summary' });
  await handlers.commands.summary(ctx);

  assert.equal(lastDigestCall().hours, 24);
  const header = ctx.replies.find((r) => r.startsWith('📝'));
  assert.ok(header, 'a summary should have been delivered');
  assert.ok(header.includes('last 24h'));
  assert.ok(header.includes('first summary here'), `header was: ${header.split('\n')[0]}`);
});

test('a later /summary covers the hours since the last delivered one', async () => {
  const { user, chat } = seedUserInChat('Since');
  fakeLastRead(user.id, chat.id, '-3.1 hours');

  const ctx = makeCtx({ chat, from: user, text: '/summary' });
  await handlers.commands.summary(ctx);

  // Rounded UP: 3.1 elapsed hours must not become a 3h window that drops the
  // six minutes the user has not seen.
  assert.equal(lastDigestCall().hours, 4);
  const header = ctx.replies.find((r) => r.startsWith('📝'));
  assert.ok(header.includes('last 4h'));
  assert.ok(header.includes('since your last summary'));
});

test('the free-plan cap still applies to a window nobody typed', async () => {
  const { user, chat } = seedUserInChat('Away');
  fakeLastRead(user.id, chat.id, '-40 hours');

  const ctx = makeCtx({ chat, from: user, text: '/summary' });
  await handlers.commands.summary(ctx);

  assert.equal(lastDigestCall().hours, 24, 'an auto window must be clamped exactly like a typed one');
  assert.ok(
    ctx.replies.some((r) => r.includes('capped to 24h on the free plan')),
    'the cap note compares against the pre-clamp window, so it must fire on the auto path too'
  );
  const header = ctx.replies.find((r) => r.startsWith('📝'));
  assert.ok(header.includes('last 24h'));
});

test('an explicit /summary 6 is untouched by a stored last-read time', async () => {
  const { user, chat } = seedUserInChat('Explicit');
  fakeLastRead(user.id, chat.id, '-40 hours');

  const ctx = makeCtx({ chat, from: user, text: '/summary 6' });
  await handlers.commands.summary(ctx);

  assert.equal(lastDigestCall().hours, 6);
  const header = ctx.replies.find((r) => r.startsWith('📝'));
  // Byte-for-byte the header it produced before this feature existed: a user
  // who typed the number is not told which window was used.
  assert.equal(header.split('\n')[0], '📝 *Summary — last 6h*');
});

test('two users whose last reads differ by minutes get one shared cache entry', async () => {
  // The reason the digest cache did not have to be re-keyed: whole-hour
  // rounding is what keeps a per-user window from fragmenting (chat_id, hours,
  // language) into one row per requester.
  const chat = { id: -8500, title: 'Shared', type: 'supergroup' };
  db.getOrCreateChat({ id: chat.id, title: chat.title, type: chat.type });
  const userA = { id: 810, username: 'a810', first_name: 'A' };
  const userB = { id: 811, username: 'b811', first_name: 'B' };
  for (const u of [userA, userB]) {
    db.getOrCreateUser({ id: u.id, username: u.username, firstName: u.first_name });
    db.linkUserToChat(chat.id, u.id);
  }
  db.saveMessage({ chatId: chat.id, messageId: 1, userId: userA.id, username: 'a810', text: 'shared talk' });

  fakeLastRead(userA.id, chat.id, '-3.1 hours');
  fakeLastRead(userB.id, chat.id, '-3.6 hours');

  await handlers.commands.summary(makeCtx({ chat, from: userA, text: '/summary' }));
  const hoursA = lastDigestCall().hours;
  await handlers.commands.summary(makeCtx({ chat, from: userB, text: '/summary' }));
  const hoursB = lastDigestCall().hours;

  assert.equal(hoursA, 4);
  assert.equal(hoursB, hoursA, 'last reads 30 minutes apart must round to the same window');
  assert.equal(
    db.db.prepare('SELECT COUNT(*) c FROM digest_cache WHERE chat_id = ?').get(chat.id).c,
    1,
    'both requests must share one cache row, not pay for two DeepSeek calls'
  );
});

test('a summary that could not be delivered does not count as read', async () => {
  const { user, chat } = seedUserInChat('Undelivered');

  const ctx = makeCtx({ chat, from: user, text: '/summary', failSummarySend: true });
  await assert.rejects(() => handlers.commands.summary(ctx));

  assert.equal(
    db.db.prepare('SELECT COUNT(*) c FROM summary_reads WHERE user_id = ? AND chat_id = ?').get(user.id, chat.id).c,
    0,
    'recording a read the user never received would skip that content for ever'
  );
});

test('a delivered summary records the read for next time', async () => {
  const { user, chat } = seedUserInChat('Recorded');
  assert.equal(db.getHoursSinceLastSummary(user.id, chat.id), null);

  await handlers.commands.summary(makeCtx({ chat, from: user, text: '/summary' }));

  const elapsed = db.getHoursSinceLastSummary(user.id, chat.id);
  assert.ok(elapsed !== null && elapsed >= 0 && elapsed < 0.1, `unexpected elapsed: ${elapsed}`);
});

test('the chat picker carries the auto sentinel and the route accepts it', async () => {
  // "null" is what a bare ${hours} would have put in the callback_data, and
  // Number('auto') is NaN — either one silently turns the new default back into
  // a fixed 24h window, with nothing to see in the logs.
  const user = { id: 820, username: 'picker', first_name: 'P' };
  const chatA = { id: -8520, title: 'PA', type: 'supergroup' };
  const chatB = { id: -8521, title: 'PB', type: 'supergroup' };
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
  db.saveMessage({ chatId: chatB.id, messageId: 1, userId: user.id, username: 'picker', text: 'pick me' });

  const privateChat = { id: user.id, type: 'private' };
  const pickerCtx = makeCtx({ chat: privateChat, from: user, subscription: sub, text: '/summary' });
  let markup;
  pickerCtx.reply = async (msg, extra) => {
    pickerCtx.replies.push(msg);
    markup = extra && extra.reply_markup;
    return { message_id: 1 };
  };
  await handlers.commands.summary(pickerCtx);

  const data = markup.inline_keyboard.map(([b]) => b.callback_data);
  assert.ok(
    data.every((d) => d.endsWith(':auto')),
    `picker must carry the sentinel, not "null": ${data.join(', ')}`
  );

  // wiring.test.js cannot catch this one: its HOLE_VALUES fixture is all
  // numbers, so the templated callback_data is never expanded with 'auto'.
  const target = data.find((d) => d.includes(String(chatB.id)));
  const route = handlers.actions.find(({ pattern }) => pattern.test && pattern.test(target));
  assert.ok(route, `no bot.action() matches ${target}`);

  const cbCtx = makeCtx({ chat: privateChat, from: user, subscription: sub, text: '' });
  cbCtx.match = route.pattern.exec(target);
  await route.fn(cbCtx);

  assert.equal(lastDigestCall().hours, 24, 'a first-time auto pick resolves to the 24h fallback');
  const header = cbCtx.replies.find((r) => r.startsWith('📝'));
  assert.ok(header.includes('first summary here'));
});
