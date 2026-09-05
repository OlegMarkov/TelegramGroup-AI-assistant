const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-consent-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

const db = require('../src/services/database');
const policy = require('../src/services/ingestionPolicy');
const ingestion = require('../src/middleware/ingestion');
const registerModeration = require('../src/commands/moderation');
const { t } = require('../src/utils/i18n');

const handlers = {};
registerModeration({
  command(name, fn) {
    handlers[name] = fn;
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

const middleware = ingestion();

/** Runs a group message through the real ingestion middleware. */
async function sendGroupMessage({ chatId, userId, text, messageId = Math.floor(Math.random() * 1e6) }) {
  let reachedNext = false;
  await middleware(
    {
      chat: { id: chatId, title: 'A Group', type: 'group' },
      from: { id: userId, username: `u${userId}`, is_bot: false },
      message: { message_id: messageId, text, date: Math.floor(Date.now() / 1000) },
      state: {},
    },
    async () => {
      reachedNext = true;
    }
  );
  return reachedNext;
}

function storedTexts(chatId) {
  return db.db
    .prepare('SELECT text FROM messages WHERE chat_id = ? ORDER BY id')
    .all(chatId)
    .map((r) => r.text);
}

function makeModerationCtx({ chatId, userId, status, type = 'group', failGetChatMember = false }) {
  const replies = [];
  return {
    chat: { id: chatId, title: 'A Group', type },
    from: { id: userId },
    message: { text: '/pause' },
    state: { lang: 'en' },
    replies,
    telegram: {
      getChatMember: async () => {
        if (failGetChatMember) throw new Error('Bad Request: user not found');
        return { status };
      },
    },
    reply: async (msg) => {
      replies.push(msg);
      return { message_id: 1 };
    },
  };
}

// --- case-02: a member who does not want to be recorded --------------------

test('an opted-out member is not stored, in any chat, but keeps using the bot', async () => {
  db.getOrCreateUser({ id: 900, username: 'quiet', firstName: 'Q' });
  db.getOrCreateUser({ id: 901, username: 'loud', firstName: 'L' });

  await sendGroupMessage({ chatId: -900, userId: 900, text: 'before opting out' });
  assert.deepEqual(storedTexts(-900), ['before opting out']);

  policy.optOutUser(900, true);

  await sendGroupMessage({ chatId: -900, userId: 900, text: 'after opting out' });
  await sendGroupMessage({ chatId: -901, userId: 900, text: 'and in a different group' });
  await sendGroupMessage({ chatId: -900, userId: 901, text: 'somebody else, still stored' });

  assert.deepEqual(
    storedTexts(-900),
    ['before opting out', 'somebody else, still stored'],
    'the opt-out applies to them and nobody else'
  );
  assert.deepEqual(storedTexts(-901), [], 'and it follows them into every other chat');

  // Opting out is not the same as leaving: they stay linked, so they can still
  // ask for summaries of the groups they are in.
  assert.equal(db.isUserLinkedToChat(-900, 900), true);

  policy.optOutUser(900, false);
  await sendGroupMessage({ chatId: -900, userId: 900, text: 'opted back in' });
  assert.ok(storedTexts(-900).includes('opted back in'), 'and it is reversible');
});

test('the opt-out survives a restart, because the cache is only a cache', () => {
  db.getOrCreateUser({ id: 902, username: 'persist', firstName: 'P' });
  policy.optOutUser(902, true);

  // What a restart does: drop the in-memory sets and read the database again.
  policy.reload();

  assert.equal(policy.isOptedOut(902), true);
  assert.equal(db.isUserOptedOut(902), true);
});

// --- case-02: an admin pausing the whole chat ------------------------------

test('a paused chat stores nothing, and keeps what it already had', async () => {
  db.getOrCreateUser({ id: 903, username: 'member', firstName: 'M' });

  await sendGroupMessage({ chatId: -903, userId: 903, text: 'said before the pause' });

  const ctx = makeModerationCtx({ chatId: -903, userId: 903, status: 'administrator' });
  await handlers.pause(ctx);
  assert.match(ctx.replies[0], /Paused/);

  await sendGroupMessage({ chatId: -903, userId: 903, text: 'said during the pause' });

  assert.deepEqual(
    storedTexts(-903),
    ['said before the pause'],
    'pausing stops collection; it is not a deletion request'
  );

  const resumeCtx = makeModerationCtx({ chatId: -903, userId: 903, status: 'creator' });
  await handlers.resume(resumeCtx);
  await sendGroupMessage({ chatId: -903, userId: 903, text: 'said after resuming' });

  assert.ok(storedTexts(-903).includes('said after resuming'));
});

test('a non-admin cannot pause a group', async () => {
  db.getOrCreateUser({ id: 904, username: 'ordinary', firstName: 'O' });
  await sendGroupMessage({ chatId: -904, userId: 904, text: 'a message' });

  const ctx = makeModerationCtx({ chatId: -904, userId: 904, status: 'member' });
  await handlers.pause(ctx);

  assert.equal(ctx.replies[0], t('en', 'moderation.adminsOnly'));
  assert.equal(policy.isChatPaused(-904), false);

  await sendGroupMessage({ chatId: -904, userId: 904, text: 'still collected' });
  assert.equal(storedTexts(-904).length, 2);
});

test('admin status that cannot be determined is treated as not-admin', async () => {
  // Fails closed. Letting any member pause a group whenever the Telegram API is
  // having a bad day is a worse outcome than an admin having to try again.
  db.getOrCreateUser({ id: 905, username: 'unknown', firstName: 'U' });

  const ctx = makeModerationCtx({ chatId: -905, userId: 905, status: 'creator', failGetChatMember: true });
  await handlers.pause(ctx);

  assert.equal(ctx.replies[0], t('en', 'moderation.adminsOnly'));
  assert.equal(policy.isChatPaused(-905), false);
});

test('/pause outside a group says so rather than doing nothing', async () => {
  db.getOrCreateUser({ id: 906, username: 'dm', firstName: 'D' });
  const ctx = makeModerationCtx({ chatId: 906, userId: 906, status: 'creator', type: 'private' });
  await handlers.pause(ctx);
  assert.equal(ctx.replies[0], t('en', 'moderation.groupOnly'));
});

test('pausing twice says so instead of pretending something changed', async () => {
  db.getOrCreateUser({ id: 907, username: 'twice', firstName: 'T' });
  await sendGroupMessage({ chatId: -907, userId: 907, text: 'hello' });

  await handlers.pause(makeModerationCtx({ chatId: -907, userId: 907, status: 'administrator' }));
  const second = makeModerationCtx({ chatId: -907, userId: 907, status: 'administrator' });
  await handlers.pause(second);

  assert.equal(second.replies[0], t('en', 'moderation.alreadyPaused'));
});

// --- case-01: reaching people who joined after the bot ---------------------

test('the join notice is posted once per throttle window, however many people join', () => {
  db.getOrCreateChat({ id: -910, title: 'Busy', type: 'group' });

  // Five people joining at once is five updates. They must produce one notice,
  // not five - a group that gets spammed removes the bot, which protects
  // nobody.
  const claims = [1, 2, 3, 4, 5].map(() => db.claimJoinNotice(-910, 24));
  assert.deepEqual(claims, [true, false, false, false, false]);

  // A day later it is due again, so a group that keeps growing keeps telling
  // people.
  db.db.prepare("UPDATE chats SET notice_posted_at = datetime('now', '-25 hours') WHERE id = -910").run();
  assert.equal(db.claimJoinNotice(-910, 24), true);
  assert.equal(db.claimJoinNotice(-910, 24), false);
});

test('the notice claim is per chat, so one busy group does not silence another', () => {
  db.getOrCreateChat({ id: -911, title: 'One', type: 'group' });
  db.getOrCreateChat({ id: -912, title: 'Two', type: 'group' });

  assert.equal(db.claimJoinNotice(-911, 24), true);
  assert.equal(db.claimJoinNotice(-912, 24), true);
});

test('every summary carries a footer naming the bot and pointing at /privacy', () => {
  // The other half of case-01: someone who reads the group without ever
  // joining while the bot was watching still sees that it is here.
  for (const lang of ['en', 'ru']) {
    const footer = t(lang, 'summary.footer');
    assert.notEqual(footer, 'summary.footer', `no ${lang} footer`);
    assert.match(footer, /\/privacy/, `the ${lang} footer must point somewhere actionable`);

    // It rides along with model output under parse_mode Markdown, so an odd
    // marker in it would take the whole summary down.
    for (const char of ['*', '_', '`']) {
      assert.equal(footer.split(char).length % 2, 1, `unbalanced ${char} in the ${lang} footer`);
    }
  }
});
