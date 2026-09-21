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
const { EVENTS } = require('../src/services/analytics');

const handlers = {};
const actions = [];
registerFind({
  command(name, fn) {
    handlers[name] = fn;
  },
  hears() {},
  action(pattern, fn) {
    actions.push({ pattern, fn });
  },
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
function makeCtx(text, { failMarkdown = false, from } = {}) {
  const replies = [];
  const editReplyMarkupCalls = [];
  return {
    chat: { id: (from && from.id) || USER_ID, type: 'private' },
    from: from || { id: USER_ID },
    state: { lang: 'en', subscription: null },
    message: { text, message_id: 1, date: Math.floor(Date.now() / 1000) },
    replies,
    reply: async (body, extra) => {
      const usedMarkdown = Boolean(extra && extra.parse_mode);
      if (failMarkdown && usedMarkdown) {
        throw new Error("Bad Request: can't parse entities");
      }
      replies.push({ body, extra: extra || {}, usedMarkdown });
      return { message_id: replies.length };
    },
    editMessageReplyMarkup: async (markup) => {
      editReplyMarkupCalls.push(markup);
      return { message_id: 1 };
    },
    editReplyMarkupCalls,
    answerCbQuery: async (msg) => replies.push({ body: msg || '', answer: true }),
  };
}

function matchAction(pattern, data) {
  if (typeof pattern === 'string') return pattern === data ? [data] : null;
  return pattern.exec(data);
}

async function runFind(text, opts) {
  const ctx = makeCtx(text, opts);
  await handlers.find(ctx);
  return ctx;
}

async function fireCallback(data, opts) {
  for (const { pattern, fn } of actions) {
    const match = matchAction(pattern, data);
    if (match) {
      const ctx = makeCtx('', opts);
      ctx.match = match;
      await fn(ctx);
      return ctx;
    }
  }
  throw new Error(`no handler matched ${data}`);
}

/** The token+offset pair of the "more" button drawn under a page, if any. */
function moreButton(ctx) {
  const last = ctx.replies[ctx.replies.length - 1];
  const markup = last && last.extra && last.extra.reply_markup;
  const button = markup && markup.inline_keyboard[0][0];
  if (!button) return null;
  const [, token, offset] = button.callback_data.match(/^find:more:([0-9a-f]{8}):(\d+)$/);
  return { data: button.callback_data, token, offset: Number(offset) };
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

test('every /find reply disables the link preview', async () => {
  seed();
  db.saveMessage({ chatId: CHAT_ID, messageId: 13, userId: 999, username: 'u', text: 'preview check message' });

  const ctx = makeCtx('/find preview');
  await handlers.find(ctx);

  for (const { extra } of ctx.replies) {
    assert.deepEqual(extra.link_preview_options, { is_disabled: true });
  }
});

test('a search for a literal % or _ means those characters, not LIKE wildcards', () => {
  // LIKE treats % and _ as wildcards, so "50%" used to match every message
  // containing "50" and "a_b" matched "axb". The user typed a string.
  db.getOrCreateUser({ id: 250, username: 'searcher', firstName: 'S' });
  db.getOrCreateChat({ id: -250, title: 'Wildcards', type: 'group' });

  const texts = [
    'discount is 50% today',
    'discount is 5000 today',
    'the file is called a_b.txt',
    'the file is called axb.txt',
    'a literal backslash \\ appears here',
  ];
  texts.forEach((text, i) => {
    db.saveMessage({ chatId: -250, messageId: i + 1, userId: 250, username: 'searcher', text });
  });

  const percent = db.searchMessages({ chatId: -250, query: '50%' });
  assert.deepEqual(
    percent.map((m) => m.text),
    ['discount is 50% today'],
    '"50%" must not also match "5000"'
  );

  const underscore = db.searchMessages({ chatId: -250, query: 'a_b' });
  assert.deepEqual(
    underscore.map((m) => m.text),
    ['the file is called a_b.txt'],
    '"a_b" must not also match "axb"'
  );

  // The escape character itself has to survive being searched for, or the
  // escaping breaks the very thing it was added to fix.
  const backslash = db.searchMessages({ chatId: -250, query: '\\' });
  assert.equal(backslash.length, 1);

  // And ordinary searches are untouched.
  assert.equal(db.searchMessages({ chatId: -250, query: 'discount' }).length, 2);
});

// --- links: /find quotes a message and points back to where it was said ---

test('a result in a -100 supergroup ends with an "open" link to the message', async () => {
  const chatId = -1005551234;
  db.getOrCreateUser({ id: 260, username: 'linker', firstName: 'L' });
  db.getOrCreateChat({ id: chatId, title: 'Private Super', type: 'supergroup' });
  db.linkUserToChat(chatId, 260);
  db.saveMessage({ chatId, messageId: 88, userId: 260, username: 'linker', text: 'unique-supergroup-fragment' });

  const ctx = makeCtx('/find unique-supergroup-fragment', { from: { id: 260 } });
  await handlers.find(ctx);

  assert.match(ctx.replies[0].body, /\[open\]\(https:\/\/t\.me\/c\/5551234\/88\)/);
});

test('a result in a chat with a username ends with a public "open" link', async () => {
  const chatId = -1005559999;
  db.getOrCreateUser({ id: 261, username: 'linker2', firstName: 'L' });
  db.getOrCreateChat({ id: chatId, title: 'Public Group', type: 'supergroup' });
  db.db.prepare('UPDATE chats SET username = ? WHERE id = ?').run('publicgroup', chatId);
  db.linkUserToChat(chatId, 261);
  db.saveMessage({ chatId, messageId: 5, userId: 261, username: 'linker2', text: 'unique-username-fragment' });

  const ctx = makeCtx('/find unique-username-fragment', { from: { id: 261 } });
  await handlers.find(ctx);

  assert.match(ctx.replies[0].body, /\[open\]\(https:\/\/t\.me\/publicgroup\/5\)/);
});

test('a result in a legacy group carries no link, rather than a broken one', async () => {
  const chatId = -12345;
  db.getOrCreateUser({ id: 262, username: 'linker3', firstName: 'L' });
  db.getOrCreateChat({ id: chatId, title: 'Legacy Group', type: 'group' });
  db.linkUserToChat(chatId, 262);
  db.saveMessage({ chatId, messageId: 1, userId: 262, username: 'linker3', text: 'unique-legacy-fragment' });

  const ctx = makeCtx('/find unique-legacy-fragment', { from: { id: 262 } });
  await handlers.find(ctx);

  assert.doesNotMatch(ctx.replies[0].body, /\[open\]/);
});

// --- paging: "more" button, ownership, the 50-result ceiling ---------------

function seedMany(chatId, userId, count, word) {
  db.getOrCreateUser({ id: userId, username: `u${userId}`, firstName: 'U' });
  db.getOrCreateChat({ id: chatId, title: `Chat${chatId}`, type: 'supergroup' });
  db.linkUserToChat(chatId, userId);
  for (let i = 0; i < count; i += 1) {
    db.saveMessage({ chatId, messageId: i + 1, userId, username: `u${userId}`, text: `${word} number ${i}` });
  }
}

test('more than a page of results draws a "more" button, and paging is stable and capped', async () => {
  const chatId = -6001;
  const userId = 6001;
  seedMany(chatId, userId, 15, 'widgetword');

  const first = await runFind('/find widgetword', { from: { id: userId } });
  const btn = moreButton(first);
  assert.ok(btn, 'a next page exists, so the button is drawn');
  assert.equal(btn.offset, 10);
  assert.match(btn.token, /^[0-9a-f]{8}$/);

  const secondCtx = await fireCallback(btn.data, { from: { id: userId } });
  // The button's own message is cleared first, then the next page is sent.
  assert.equal(secondCtx.editReplyMarkupCalls.length, 1);
  const pageTwo = secondCtx.replies.find((r) => !r.answer);
  assert.match(pageTwo.body, /More results/i);
  assert.equal(moreButton(secondCtx), null, 'only 5 results remained: no further page');
});

test('only the person who ran the search can page through it', async () => {
  const chatId = -6002;
  const userId = 6002;
  const otherUserId = 6003;
  seedMany(chatId, userId, 15, 'gadgetword');

  const first = await runFind('/find gadgetword', { from: { id: userId } });
  const btn = moreButton(first);
  assert.ok(btn);

  const stranger = await fireCallback(btn.data, { from: { id: otherUserId } });
  assert.equal(stranger.replies.length, 1);
  assert.equal(stranger.replies[0].answer, true);
  assert.match(stranger.replies[0].body, /expired/i);

  // An unknown token behaves identically.
  const bogus = await fireCallback(`find:more:${'0'.repeat(8)}:10`, { from: { id: userId } });
  assert.match(bogus.replies[0].body, /expired/i);
});

test('results stop at 50, however many actually match', async () => {
  const chatId = -6004;
  const userId = 6004;
  seedMany(chatId, userId, 65, 'ceilingword');

  // Each result line is "ceilingword number <n>"; the header also names the
  // query once per page, so only lines with a trailing number are counted.
  const countResults = (ctx) =>
    ctx.replies
      .filter((r) => !r.answer)
      .reduce((n, r) => n + (r.body.match(/ceilingword number \d+/g) || []).length, 0);

  let ctx = await runFind('/find ceilingword', { from: { id: userId } });
  let total = countResults(ctx);
  let btn = moreButton(ctx);

  while (btn) {
    ctx = await fireCallback(btn.data, { from: { id: userId } });
    total += countResults(ctx);
    btn = moreButton(ctx);
  }

  assert.equal(total, 50, 'paging never goes past the ceiling, even with more real matches');
});

test('an empty search is counted, distinctly from a request', async () => {
  seed();
  const before = db.db.prepare('SELECT COUNT(*) c FROM events WHERE user_id = ? AND event_type = ?').get(
    USER_ID,
    EVENTS.FIND_NO_RESULTS
  ).c;

  const ctx = makeCtx('/find totallyabsentword');
  await handlers.find(ctx);

  assert.match(ctx.replies[0].body, /No results/i);
  assert.equal(
    db.db.prepare('SELECT COUNT(*) c FROM events WHERE user_id = ? AND event_type = ?').get(
      USER_ID,
      EVENTS.FIND_NO_RESULTS
    ).c,
    before + 1
  );
});

// --- full-text search: prefixes, ё/е folding, AND, fallback, sync on delete ---

test('hasFullTextSearch is on for this build, which is what the rest of this section exercises', () => {
  assert.equal(db.hasFullTextSearch, true, 'FTS5 must be compiled into this node build for these tests to be meaningful');
});

test('a whole word finds its own longer forms, the same way filter keywords do', () => {
  const chatId = -7001;
  db.getOrCreateUser({ id: 7001, username: 'p1', firstName: 'P' });
  db.getOrCreateChat({ id: chatId, title: 'Prefix', type: 'group' });
  db.saveMessage({ chatId, messageId: 1, userId: 7001, username: 'p1', text: 'the new release is out' });
  db.saveMessage({ chatId, messageId: 2, userId: 7001, username: 'p1', text: 'quarterly releases are planned' });
  db.saveMessage({ chatId, messageId: 3, userId: 7001, username: 'p1', text: 'nothing relevant here' });

  const found = db.searchMessages({ chatId, query: 'release' }).map((m) => m.text);
  assert.ok(found.some((t) => t.includes('the new release is out')));
  assert.ok(found.some((t) => t.includes('quarterly releases are planned')), '"release" must also find "releases"');
});

test('ё and е fold into the same letter in both directions', () => {
  const chatId = -7002;
  db.getOrCreateUser({ id: 7002, username: 'p2', firstName: 'P' });
  db.getOrCreateChat({ id: chatId, title: 'Yo', type: 'group' });
  db.saveMessage({ chatId, messageId: 1, userId: 7002, username: 'p2', text: 'молодые учёные выступили' });
  db.saveMessage({ chatId, messageId: 2, userId: 7002, username: 'p2', text: 'опытные ученые подтвердили' });

  const withYo = db.searchMessages({ chatId, query: 'ученые' }).map((m) => m.text);
  assert.ok(withYo.some((t) => t.includes('учёные')), '"ученые" (е) must find text stored with ё');
  assert.ok(withYo.some((t) => t.includes('ученые')), 'and still find its own exact spelling');

  const withYe = db.searchMessages({ chatId, query: 'учёные' }).map((m) => m.text);
  assert.ok(withYe.some((t) => t.includes('учёные')));
  assert.ok(withYe.some((t) => t.includes('опытные ученые подтвердили')), '"учёные" (ё) must find text stored with е');
});

test('several words are ANDed, not ORed', () => {
  const chatId = -7003;
  db.getOrCreateUser({ id: 7003, username: 'p3', firstName: 'P' });
  db.getOrCreateChat({ id: chatId, title: 'And', type: 'group' });
  db.saveMessage({ chatId, messageId: 1, userId: 7003, username: 'p3', text: 'we should deploy the release' });
  db.saveMessage({ chatId, messageId: 2, userId: 7003, username: 'p3', text: 'we should deploy this weekend' });
  db.saveMessage({ chatId, messageId: 3, userId: 7003, username: 'p3', text: 'the release notes are ready' });

  const both = db.searchMessages({ chatId, query: 'deploy release' }).map((m) => m.text);
  assert.deepEqual(both, ['we should deploy the release'], 'only the message containing both words matches');
});

test('paging by limit/offset does not repeat or skip results, in a stable order', () => {
  const chatId = -7004;
  db.getOrCreateUser({ id: 7004, username: 'p4', firstName: 'P' });
  db.getOrCreateChat({ id: chatId, title: 'Paged', type: 'group' });
  for (let i = 0; i < 12; i += 1) {
    db.saveMessage({ chatId, messageId: i + 1, userId: 7004, username: 'p4', text: `pageword entry ${i}` });
  }

  const pageOne = db.searchMessages({ chatId, query: 'pageword', limit: 5, offset: 0 });
  const pageTwo = db.searchMessages({ chatId, query: 'pageword', limit: 5, offset: 5 });
  const pageOneAgain = db.searchMessages({ chatId, query: 'pageword', limit: 5, offset: 0 });

  assert.equal(pageOne.length, 5);
  assert.equal(pageTwo.length, 5);
  assert.deepEqual(pageOne.map((m) => m.id), pageOneAgain.map((m) => m.id), 'the same page is stable across calls');

  const idsOne = new Set(pageOne.map((m) => m.id));
  const idsTwo = new Set(pageTwo.map((m) => m.id));
  assert.equal([...idsOne].filter((id) => idsTwo.has(id)).length, 0, 'no result appears on two pages');
});

test('a mid-word fragment with no FTS hits falls back to a substring search', () => {
  const chatId = -7005;
  db.getOrCreateUser({ id: 7005, username: 'p5', firstName: 'P' });
  db.getOrCreateChat({ id: chatId, title: 'Fallback', type: 'group' });
  db.saveMessage({ chatId, messageId: 1, userId: 7005, username: 'p5', text: 'we will deploy tonight' });

  // "ploy" is a valid FTS prefix term but matches no token as a PREFIX (the
  // word is "deploy", which does not start with "ploy"), so FTS finds
  // nothing and the substring fallback is what actually finds it.
  const found = db.searchMessages({ chatId, query: 'ploy' }).map((m) => m.text);
  assert.deepEqual(found, ['we will deploy tonight']);
});

test('a purged message stops being found', () => {
  const chatId = -7006;
  db.getOrCreateUser({ id: 7006, username: 'p6', firstName: 'P' });
  db.getOrCreateChat({ id: chatId, title: 'Purged', type: 'group' });
  db.saveMessage({
    chatId,
    messageId: 1,
    userId: 7006,
    username: 'p6',
    text: 'aging retentionword message',
    createdAt: '2000-01-01T00:00:00.000Z',
  });
  db.saveMessage({ chatId, messageId: 2, userId: 7006, username: 'p6', text: 'fresh retentionword message' });

  assert.equal(db.searchMessages({ chatId, query: 'retentionword' }).length, 2);
  db.purgeExpiredMessages(90);
  const after = db.searchMessages({ chatId, query: 'retentionword' }).map((m) => m.text);
  assert.deepEqual(after, ['fresh retentionword message'], 'the purged message never comes back from search');
});

test("a deleted user's messages stop being found", () => {
  const chatId = -7007;
  const userId = 7007;
  db.getOrCreateUser({ id: userId, username: 'p7', firstName: 'P' });
  db.getOrCreateChat({ id: chatId, title: 'Deleted', type: 'group' });
  db.saveMessage({ chatId, messageId: 1, userId, username: 'p7', text: 'forgetmeword please remove this' });

  assert.equal(db.searchMessages({ chatId, query: 'forgetmeword' }).length, 1);
  db.deleteUserData(userId);
  assert.equal(db.searchMessages({ chatId, query: 'forgetmeword' }).length, 0);
});

test('a chat removed by cascade takes its messages out of the index too', () => {
  const chatId = -7008;
  db.getOrCreateUser({ id: 7008, username: 'p8', firstName: 'P' });
  db.getOrCreateChat({ id: chatId, title: 'Cascaded', type: 'group' });
  db.saveMessage({ chatId, messageId: 1, userId: 7008, username: 'p8', text: 'cascadeword before deletion' });

  assert.equal(db.searchMessages({ chatId, query: 'cascadeword' }).length, 1);
  // A hard delete of the chat row, the way a FOREIGN KEY cascade removes
  // messages from many places at once — retention, /forgetme, and this.
  db.db.prepare('DELETE FROM chats WHERE id = ?').run(chatId);
  assert.equal(db.searchMessages({ chatId, query: 'cascadeword' }).length, 0);
});
