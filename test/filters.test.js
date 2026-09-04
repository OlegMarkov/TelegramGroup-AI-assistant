const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-filters-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

const db = require('../src/services/database');
const { buildFilterMatcher } = require('../src/services/filterMatcher');
const { MAX_KEYWORDS, MAX_KEYWORD_LENGTH } = require('../src/models/filter');
const registerFilter = require('../src/commands/filter');

const handlers = { commands: {}, actions: [], text: null };
const fakeBot = {
  command(name, fn) {
    handlers.commands[name] = fn;
  },
  hears() {},
  action(pattern, fn) {
    handlers.actions.push({ pattern, fn });
  },
  on(event, fn) {
    if (event === 'text') handlers.text = fn;
  },
};
registerFilter(fakeBot);

function makeCtx({ from, text, chatType }) {
  const replies = [];
  const edits = [];
  const markups = [];
  const record = (extra) => {
    if (extra && extra.reply_markup) markups.push(extra.reply_markup);
  };
  return {
    chat: { id: from.id, type: chatType || 'private' },
    from,
    state: { subscription: null, lang: 'en' },
    message: { text, message_id: 1, date: Math.floor(Date.now() / 1000) },
    replies,
    edits,
    markups,
    reply: async (msg, extra) => {
      replies.push(msg);
      record(extra);
      return { message_id: 1 };
    },
    editMessageText: async (msg, extra) => {
      edits.push(msg);
      record(extra);
      return { message_id: 1 };
    },
    answerCbQuery: async (msg) => replies.push(msg || ''),
  };
}

/** Labels of the last keyboard drawn, flattened across rows. */
function buttons(ctx) {
  const markup = ctx.markups[ctx.markups.length - 1];
  if (!markup) return [];
  return markup.inline_keyboard.flat().map((b) => b.text);
}

function callbackFor(ctx, matcher) {
  const markup = ctx.markups[ctx.markups.length - 1];
  const button = markup.inline_keyboard.flat().find((b) => matcher.test(b.text));
  return button && button.callback_data;
}

async function run(command, opts) {
  const ctx = makeCtx(opts);
  await handlers.commands[command](ctx);
  return ctx;
}

function matchAction(pattern, data) {
  if (typeof pattern === 'string') return pattern === data ? [data] : null;
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

/** A plain message in DM, as it reaches the keyword-prompt capture. */
async function sendText(text, opts) {
  const ctx = makeCtx({ ...opts, text });
  ctx.passedThrough = false;
  await handlers.text(ctx, async () => {
    ctx.passedThrough = true;
  });
  return ctx;
}

/** Opens the keywords screen and returns the callback_data of one row. */
async function keywordButton(user, matcher) {
  const ctx = await fireCallback('filter:keywords', { from: user });
  return callbackFor(ctx, matcher);
}

function newUser(id, name) {
  const user = { id, first_name: name };
  db.getOrCreateUser({ id, firstName: name });
  return user;
}

test.after(() => {
  db.db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

test('the topics screen offers a way into keywords, and says what is set there', async () => {
  const user = newUser(800, 'Topics');

  const empty = await run('filter', { from: user, text: '/filter' });
  assert.ok(
    buttons(empty).some((l) => /Add my own keywords/i.test(l)),
    'with none set, the button says what it is for rather than showing a zero'
  );

  db.setUserFilters(user.id, { keywords: ['deploy'], categories: [] });
  const withOne = await run('filter', { from: user, text: '/filter' });
  assert.ok(buttons(withOne).some((l) => /My keywords \(1\)/.test(l)), 'once set it carries the count');
  assert.match(withOne.replies[0], /deploy/, 'and the topics screen names them, so they are not out of sight');
});

test('keywords are added from one message, one per line or comma separated', async () => {
  const user = newUser(801, 'Adder');

  await fireCallback('filter:kw:add', { from: user });
  const ctx = await sendText('deploy, release notes\nAnna', { from: user });

  assert.equal(ctx.passedThrough, false, 'the answer was consumed, not passed on');
  assert.deepEqual(db.getUserFilters(user.id).keywords, ['deploy', 'release notes', 'Anna']);
  assert.match(ctx.replies[0], /Added: deploy, release notes, Anna/);
});

test('a multi-word keyword is kept whole, because the matcher handles phrases', () => {
  // Splitting on spaces would turn one precise filter into two noisy ones:
  // "release notes" would start firing on every "release" and every "notes".
  const matches = buildFilterMatcher({ keywords: ['release notes'], categories: [] });
  assert.equal(matches('the release notes are up'), true);
  assert.equal(matches('a release is planned'), false, 'half the phrase is not a match');
});

test('a keyword follows the word into its other endings', async () => {
  // The whole reason keywords are stems: nobody is going to type every ending.
  const user = newUser(802, 'Stemmer');
  await fireCallback('filter:kw:add', { from: user });
  await sendText('релиз', { from: user });

  const matches = buildFilterMatcher(db.getUserFilters(user.id));
  assert.equal(matches('обсудим релизы завтра'), true);
  assert.equal(matches('готовим релиза план'), true);
});

test('the same word twice is reported, not stored twice', async () => {
  // Case and ё/е are one word to the matcher, so they have to be one word here
  // too — otherwise the list fills up with entries that all do the same thing.
  const user = newUser(803, 'Duper');
  db.setUserFilters(user.id, { keywords: ['учёные'], categories: [] });

  await fireCallback('filter:kw:add', { from: user });
  const ctx = await sendText('Ученые, deploy', { from: user });

  assert.deepEqual(db.getUserFilters(user.id).keywords, ['учёные', 'deploy']);
  assert.match(ctx.replies[0], /Already following: Ученые/);
});

test('an over-long word is skipped and named, and the rest still land', async () => {
  const user = newUser(804, 'Verbose');
  const tooLong = 'x'.repeat(MAX_KEYWORD_LENGTH + 1);

  await fireCallback('filter:kw:add', { from: user });
  const ctx = await sendText(`${tooLong}, deploy`, { from: user });

  assert.deepEqual(db.getUserFilters(user.id).keywords, ['deploy'], 'the good one is kept');
  assert.match(ctx.replies[0], new RegExp(`over ${MAX_KEYWORD_LENGTH} characters`));
});

test('the cap holds, and what did not fit is named rather than dropped silently', async () => {
  const user = newUser(805, 'Hoarder');
  const existing = Array.from({ length: MAX_KEYWORDS - 1 }, (_, i) => `word_${i}`);
  db.setUserFilters(user.id, { keywords: existing, categories: [] });

  await fireCallback('filter:kw:add', { from: user });
  const ctx = await sendText('fits, overflows', { from: user });

  const stored = db.getUserFilters(user.id).keywords;
  assert.equal(stored.length, MAX_KEYWORDS);
  assert.equal(stored[stored.length - 1], 'fits');
  assert.match(ctx.replies[0], /Added: fits/);
  assert.match(ctx.replies[0], /didn't fit: overflows/);

  // And at the ceiling the button says so instead of asking for words it would refuse.
  const atLimit = await fireCallback('filter:kw:add', { from: user });
  assert.match(atLimit.replies.join('\n'), /already following \d+ keywords/i);
  const after = await sendText('nope', { from: user });
  assert.equal(after.passedThrough, true, 'the prompt was never armed');
});

test('an answer with no words in it keeps the prompt open', async () => {
  const user = newUser(806, 'Blank');

  await fireCallback('filter:kw:add', { from: user });
  const blank = await sendText(',,,', { from: user });
  assert.match(blank.replies[0], /couldn't find any words/i);
  assert.equal(db.getUserFilters(user.id).keywords.length, 0);

  // Still waiting: retyping is enough, no second trip through the button.
  const retry = await sendText('deploy', { from: user });
  assert.equal(retry.passedThrough, false);
  assert.deepEqual(db.getUserFilters(user.id).keywords, ['deploy']);
});

test('selecting keywords and pressing Remove drops exactly those', async () => {
  const user = newUser(807, 'Remover');
  db.setUserFilters(user.id, { keywords: ['alpha', 'beta', 'gamma'], categories: [] });

  const alpha = await keywordButton(user, /alpha/);
  const gamma = await keywordButton(user, /gamma/);
  await fireCallback(alpha, { from: user });
  const ticked = await fireCallback(gamma, { from: user });

  assert.ok(buttons(ticked).some((l) => /Remove \(2\)/.test(l)), 'the button counts what is ticked');

  const removed = await fireCallback('filter:kw:remove', { from: user });
  assert.ok(removed.replies.some((r) => /Removed: alpha, gamma/.test(r)), 'both are named back');
  assert.deepEqual(db.getUserFilters(user.id).keywords, ['beta']);
});

test('Remove with nothing ticked asks for a selection instead of clearing the list', async () => {
  const user = newUser(808, 'Careful');
  db.setUserFilters(user.id, { keywords: ['alpha'], categories: [] });

  const ctx = await fireCallback('filter:kw:remove', { from: user });
  assert.ok(ctx.replies.some((r) => /Tap a keyword/i.test(r)));
  assert.deepEqual(db.getUserFilters(user.id).keywords, ['alpha'], 'nothing was removed');
});

test('a row id from a stale keyboard matches nothing and cannot remove the wrong word', async () => {
  // Rows are addressed by a hash of the keyword rather than by its position,
  // so a button drawn before an edit resolves to that word or to nothing —
  // never to whatever has since moved into its slot.
  const user = newUser(809, 'Stale');
  db.setUserFilters(user.id, { keywords: ['first', 'second'], categories: [] });

  const firstRow = await keywordButton(user, /first/);
  db.setUserFilters(user.id, { keywords: ['second'], categories: [] });

  const ctx = await fireCallback(firstRow, { from: user });
  assert.ok(ctx.replies.some((r) => /isn't in your list any more/i.test(r)));
  assert.deepEqual(db.getUserFilters(user.id).keywords, ['second'], 'the survivor is untouched');
});

test('keywords and topics are independent, and both survive the other being edited', async () => {
  const user = newUser(810, 'Both');
  db.setUserFilters(user.id, { keywords: ['deploy'], categories: [] });

  await fireCallback('filter:category:Tech', { from: user });
  assert.deepEqual(db.getUserFilters(user.id).categories, ['Tech']);
  assert.deepEqual(db.getUserFilters(user.id).keywords, ['deploy'], 'toggling a topic keeps keywords');

  await fireCallback('filter:kw:add', { from: user });
  await sendText('anna', { from: user });
  assert.deepEqual(db.getUserFilters(user.id).categories, ['Tech'], 'adding a keyword keeps topics');

  const done = await fireCallback('filter:done', { from: user });
  const summary = done.replies.join('\n');
  assert.match(summary, /Topics: Tech/);
  assert.match(summary, /Keywords: deploy, anna/);
});

test('Done on an empty filter set says everything comes through', async () => {
  const user = newUser(811, 'Empty');
  const ctx = await fireCallback('filter:done', { from: user });
  assert.ok(ctx.replies.some((r) => /cleared/i.test(r)));
});

test('commands and menu buttons are never swallowed by a pending keyword prompt', async () => {
  const user = newUser(812, 'Escapee');

  await fireCallback('filter:kw:add', { from: user });
  const menuTap = await sendText('⭐ Subscribe', { from: user });
  assert.equal(menuTap.passedThrough, true);

  const command = await sendText('/summary', { from: user });
  assert.equal(command.passedThrough, true);
  assert.equal(db.getUserFilters(user.id).keywords.length, 0, 'nothing was stored along the way');
});

test('nothing is captured in a group, where the next message is somebody talking', async () => {
  const user = newUser(813, 'Grouped');

  const tapped = await fireCallback('filter:kw:add', { from: user, chatType: 'supergroup' });
  assert.ok(tapped.replies.some((r) => /private chat/i.test(r)));

  const chatter = await sendText('anything at all', { from: user, chatType: 'supergroup' });
  assert.equal(chatter.passedThrough, true);
  assert.equal(db.getUserFilters(user.id).keywords.length, 0);
});

test('a keyword never reaches a group message, whoever taps the buttons', async () => {
  // A /filter message in a group is one message shared by everyone in it, and
  // whoever taps a button edits what the whole group sees. Categories were
  // always like that; "квартальный отчёт" is nobody else's business.
  const user = newUser(816, 'Private');
  const secret = 'severance package';
  db.setUserFilters(user.id, { keywords: [secret], categories: ['Tech'] });

  const inGroup = { from: user, chatType: 'supergroup' };
  const everythingSaid = (ctx) => [...ctx.replies, ...ctx.edits, ...buttons(ctx)].join('\n');

  const opened = await run('filter', { ...inGroup, text: '/filter' });
  assert.ok(!everythingSaid(opened).includes(secret), 'not on the topics screen');
  assert.ok(
    !buttons(opened).some((l) => /My keywords \(\d+\)/.test(l)),
    'and not even as a count, which would leak how many they follow'
  );

  const toggled = await fireCallback('filter:category:Science', inGroup);
  assert.ok(!everythingSaid(toggled).includes(secret), 'not when someone edits the shared message');

  const listed = await fireCallback('filter:keywords', inGroup);
  assert.ok(!everythingSaid(listed).includes(secret), 'the list itself refuses to open');
  assert.equal(listed.edits.length, 0, 'so the shared message is left as it was');

  const done = await fireCallback('filter:done', inGroup);
  assert.ok(!everythingSaid(done).includes(secret), 'and not in the summary at the end');

  // In a DM the same user sees all of it.
  const dm = await run('filter', { from: user, text: '/filter' });
  assert.match(dm.replies[0], /severance package/);
});

test('a stray keyword callback from a group cannot edit anything', async () => {
  const user = newUser(817, 'Forged');
  db.setUserFilters(user.id, { keywords: ['alpha'], categories: [] });
  const row = await keywordButton(user, /alpha/);

  const inGroup = { from: user, chatType: 'supergroup' };
  const toggled = await fireCallback(row, inGroup);
  assert.equal(toggled.edits.length, 0);

  const removed = await fireCallback('filter:kw:remove', inGroup);
  assert.equal(removed.edits.length, 0);
  assert.deepEqual(db.getUserFilters(user.id).keywords, ['alpha'], 'and nothing was removed');
});

test('cancelling the prompt, or walking back to topics, leaves the next message alone', async () => {
  const user = newUser(814, 'Canceller');

  await fireCallback('filter:kw:add', { from: user });
  const cancelled = await fireCallback('filter:kw:addcancel', { from: user });
  assert.match(cancelled.edits[0], /Cancelled/i);
  assert.equal((await sendText('@ignored', { from: user })).passedThrough, true);

  // Back does the same: leaving the screen abandons the question it asked.
  await fireCallback('filter:kw:add', { from: user });
  await fireCallback('filter:back', { from: user });
  assert.equal((await sendText('also ignored', { from: user })).passedThrough, true);
  assert.equal(db.getUserFilters(user.id).keywords.length, 0);
});

test('a keyword is highlighted in a digest the same way a category is', async () => {
  // The point of the whole screen: what you type here has to reach the matcher
  // that digest.js runs over every message in the window.
  const user = newUser(815, 'Endtoend');

  await fireCallback('filter:kw:add', { from: user });
  await sendText('квартальный отчёт', { from: user });

  const matches = buildFilterMatcher(db.getUserFilters(user.id));
  assert.equal(matches('прислали квартальный отчет по продажам'), true, 'ё and е are the same word');
  assert.equal(matches('годовой отчет'), false);
});
