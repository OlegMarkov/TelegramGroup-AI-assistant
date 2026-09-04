const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-find-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

const db = require('../src/services/database');
const registerFind = require('../src/commands/find');

const handlers = {};
registerFind({
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

const CHAT_ID = -500;
const USER_ID = 500;

function seed() {
  db.getOrCreateUser({ id: USER_ID, username: 'searcher', firstName: 'S' });
  db.getOrCreateChat({ id: CHAT_ID, title: 'Group *with* markup', type: 'supergroup' });
  db.linkUserToChat(CHAT_ID, USER_ID);
}

/**
 * A DM context, which is the path that searches across the user's groups.
 *
 * `failMarkdown` makes the first Markdown-mode send throw the way Telegram
 * does on a parse error, so the plain-text retry can be exercised.
 */
function makeCtx(text, { failMarkdown = false } = {}) {
  const replies = [];
  return {
    chat: { id: USER_ID, type: 'private' },
    from: { id: USER_ID },
    state: { lang: 'en', subscription: null },
    message: { text, message_id: 1, date: Math.floor(Date.now() / 1000) },
    replies,
    reply: async (body, extra) => {
      const usedMarkdown = Boolean(extra && extra.parse_mode);
      if (failMarkdown && usedMarkdown) {
        throw new Error("Bad Request: can't parse entities");
      }
      replies.push({ body, usedMarkdown });
      return { message_id: replies.length };
    },
  };
}

test('search results escape Markdown in the message body, author and chat title', async () => {
  seed();
  db.saveMessage({
    chatId: CHAT_ID,
    messageId: 10,
    userId: 999,
    // Every field here is written by someone other than the person reading it.
    username: 'evil_*user*',
    text: 'deploy notes: [click here](http://evil.example) and _read_ this',
  });

  const ctx = makeCtx('/find deploy');
  await handlers.find(ctx);

  assert.equal(ctx.replies.length, 1);
  const { body, usedMarkdown } = ctx.replies[0];
  assert.equal(usedMarkdown, true, 'results are still formatted');

  // The bug this guards: unescaped, this renders as a link the reader has
  // every reason to attribute to the bot.
  assert.ok(
    body.includes('\\[click here\\]\\(http://evil.example\\)') ||
      body.includes('\\[click here\\](http://evil.example)'),
    `the link syntax must be inert, got: ${body}`
  );
  assert.ok(!/\[click here\]\(http/.test(body), 'no live link markup survives');
  assert.ok(body.includes('\\_read\\_'), 'italic markers in the body are escaped');
  assert.ok(body.includes('evil\\_\\*user\\*'), 'the author name is escaped');
  assert.ok(body.includes('Group \\*with\\* markup'), 'the chat title is escaped');
});

test('an author with no username falls back to a localized label, not a literal', async () => {
  seed();
  db.saveMessage({ chatId: CHAT_ID, messageId: 11, userId: null, username: null, text: 'anonymous rollout note' });

  const ctx = makeCtx('/find rollout');
  await handlers.find(ctx);

  assert.match(ctx.replies[0].body, /\*someone\*/);
});

test('results are delivered unformatted rather than lost when Telegram rejects the Markdown', async () => {
  seed();
  db.saveMessage({ chatId: CHAT_ID, messageId: 12, userId: 999, username: 'u', text: 'retry me please' });

  const ctx = makeCtx('/find retry', { failMarkdown: true });
  await handlers.find(ctx);

  assert.equal(ctx.replies.length, 1, 'the user still gets exactly one reply');
  assert.equal(ctx.replies[0].usedMarkdown, false, 'and it is the plain-text one');
  assert.match(ctx.replies[0].body, /retry me please/);
});

test('an oversized result set is split rather than rejected whole', async () => {
  seed();
  // Escaping adds a backslash per special character, so a result set that fit
  // before can now cross Telegram's 4096-character limit — which rejects the
  // send outright instead of trimming it.
  const dense = '*_[]`'.repeat(40); // 200 chars, every one of them escaped
  for (let i = 0; i < 10; i += 1) {
    db.saveMessage({
      chatId: CHAT_ID,
      messageId: 100 + i,
      userId: 999,
      username: 'noisy',
      text: `oversized ${dense}`,
    });
  }

  const ctx = makeCtx('/find oversized');
  await handlers.find(ctx);

  assert.ok(ctx.replies.length > 1, 'the results arrive in several messages');
  for (const { body } of ctx.replies) {
    assert.ok(body.length <= 4096, `each part must fit Telegram's limit, got ${body.length}`);
  }
});
