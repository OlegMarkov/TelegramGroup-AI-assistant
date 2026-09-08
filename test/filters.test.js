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
const { allowedKeywords, MAX_KEYWORDS, MAX_KEYWORD_LENGTH } = require('../src/models/filter');
const { FREE_LIMITS, PREMIUM_LIMITS } = require('../src/models/subscription');
const registerFilter = require('../src/commands/filter');
const alerts = require('../src/services/keywordAlerts');

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

const PREMIUM = { plan: 'monthly', status: 'active' };

function makeCtx({ from, text, chatType, subscription }) {
  const replies = [];
  const edits = [];
  const markups = [];
  const record = (extra) => {
    if (extra && extra.reply_markup) markups.push(extra.reply_markup);
  };
  return {
    chat: { id: from.id, type: chatType || 'private' },
    from,
    state: { subscription: subscription || null, lang: 'en' },
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
async function keywordButton(user, matcher, subscription = PREMIUM) {
  const ctx = await fireCallback('filter:keywords', { from: user, subscription });
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

  const empty = await run('filter', { from: user, subscription: PREMIUM, text: '/filter' });
  assert.ok(
    buttons(empty).some((l) => /Add my own keywords/i.test(l)),
    'with none set, the button says what it is for rather than showing a zero'
  );

  db.setUserFilters(user.id, { keywords: ['deploy'], categories: [] });
  const withOne = await run('filter', { from: user, subscription: PREMIUM, text: '/filter' });
  assert.ok(buttons(withOne).some((l) => /My keywords \(1\)/.test(l)), 'once set it carries the count');
  assert.match(withOne.replies[0], /deploy/, 'and the topics screen names them, so they are not out of sight');
});

test('keywords are added from one message, one per line or comma separated', async () => {
  const user = newUser(801, 'Adder');

  await fireCallback('filter:kw:add', { from: user, subscription: PREMIUM });
  const ctx = await sendText('deploy, release notes\nAnna', { from: user, subscription: PREMIUM });

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
  await fireCallback('filter:kw:add', { from: user, subscription: PREMIUM });
  await sendText('релиз', { from: user, subscription: PREMIUM });

  const matches = buildFilterMatcher(db.getUserFilters(user.id));
  assert.equal(matches('обсудим релизы завтра'), true);
  assert.equal(matches('готовим релиза план'), true);
});

test('the same word twice is reported, not stored twice', async () => {
  // Case and ё/е are one word to the matcher, so they have to be one word here
  // too — otherwise the list fills up with entries that all do the same thing.
  const user = newUser(803, 'Duper');
  db.setUserFilters(user.id, { keywords: ['учёные'], categories: [] });

  await fireCallback('filter:kw:add', { from: user, subscription: PREMIUM });
  const ctx = await sendText('Ученые, deploy', { from: user, subscription: PREMIUM });

  assert.deepEqual(db.getUserFilters(user.id).keywords, ['учёные', 'deploy']);
  assert.match(ctx.replies[0], /Already following: Ученые/);
});

test('an over-long word is skipped and named, and the rest still land', async () => {
  const user = newUser(804, 'Verbose');
  const tooLong = 'x'.repeat(MAX_KEYWORD_LENGTH + 1);

  await fireCallback('filter:kw:add', { from: user, subscription: PREMIUM });
  const ctx = await sendText(`${tooLong}, deploy`, { from: user, subscription: PREMIUM });

  assert.deepEqual(db.getUserFilters(user.id).keywords, ['deploy'], 'the good one is kept');
  assert.match(ctx.replies[0], new RegExp(`over ${MAX_KEYWORD_LENGTH} characters`));
});

test('the cap holds, and what did not fit is named rather than dropped silently', async () => {
  const user = newUser(805, 'Hoarder');
  const existing = Array.from({ length: MAX_KEYWORDS - 1 }, (_, i) => `word_${i}`);
  db.setUserFilters(user.id, { keywords: existing, categories: [] });

  await fireCallback('filter:kw:add', { from: user, subscription: PREMIUM });
  const ctx = await sendText('fits, overflows', { from: user, subscription: PREMIUM });

  const stored = db.getUserFilters(user.id).keywords;
  assert.equal(stored.length, MAX_KEYWORDS);
  assert.equal(stored[stored.length - 1], 'fits');
  assert.match(ctx.replies[0], /Added: fits/);
  assert.match(ctx.replies[0], /didn't fit: overflows/);

  // And at the ceiling the button says so instead of asking for words it would refuse.
  const atLimit = await fireCallback('filter:kw:add', { from: user, subscription: PREMIUM });
  assert.match(atLimit.replies.join('\n'), /already following \d+ keywords/i);
  const after = await sendText('nope', { from: user, subscription: PREMIUM });
  assert.equal(after.passedThrough, true, 'the prompt was never armed');
});

test('an answer with no words in it keeps the prompt open', async () => {
  const user = newUser(806, 'Blank');

  await fireCallback('filter:kw:add', { from: user, subscription: PREMIUM });
  const blank = await sendText(',,,', { from: user, subscription: PREMIUM });
  assert.match(blank.replies[0], /couldn't find any words/i);
  assert.equal(db.getUserFilters(user.id).keywords.length, 0);

  // Still waiting: retyping is enough, no second trip through the button.
  const retry = await sendText('deploy', { from: user, subscription: PREMIUM });
  assert.equal(retry.passedThrough, false);
  assert.deepEqual(db.getUserFilters(user.id).keywords, ['deploy']);
});

test('selecting keywords and pressing Remove drops exactly those', async () => {
  const user = newUser(807, 'Remover');
  db.setUserFilters(user.id, { keywords: ['alpha', 'beta', 'gamma'], categories: [] });

  const alpha = await keywordButton(user, /alpha/);
  const gamma = await keywordButton(user, /gamma/);
  await fireCallback(alpha, { from: user, subscription: PREMIUM });
  const ticked = await fireCallback(gamma, { from: user, subscription: PREMIUM });

  assert.ok(buttons(ticked).some((l) => /Remove \(2\)/.test(l)), 'the button counts what is ticked');

  const removed = await fireCallback('filter:kw:remove', { from: user, subscription: PREMIUM });
  assert.ok(removed.replies.some((r) => /Removed: alpha, gamma/.test(r)), 'both are named back');
  assert.deepEqual(db.getUserFilters(user.id).keywords, ['beta']);
});

test('Remove with nothing ticked asks for a selection instead of clearing the list', async () => {
  const user = newUser(808, 'Careful');
  db.setUserFilters(user.id, { keywords: ['alpha'], categories: [] });

  const ctx = await fireCallback('filter:kw:remove', { from: user, subscription: PREMIUM });
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

  const ctx = await fireCallback(firstRow, { from: user, subscription: PREMIUM });
  assert.ok(ctx.replies.some((r) => /isn't in your list any more/i.test(r)));
  assert.deepEqual(db.getUserFilters(user.id).keywords, ['second'], 'the survivor is untouched');
});

test('keywords and topics are independent, and both survive the other being edited', async () => {
  const user = newUser(810, 'Both');
  db.setUserFilters(user.id, { keywords: ['deploy'], categories: [] });

  await fireCallback('filter:category:Tech', { from: user, subscription: PREMIUM });
  assert.deepEqual(db.getUserFilters(user.id).categories, ['Tech']);
  assert.deepEqual(db.getUserFilters(user.id).keywords, ['deploy'], 'toggling a topic keeps keywords');

  await fireCallback('filter:kw:add', { from: user, subscription: PREMIUM });
  await sendText('anna', { from: user, subscription: PREMIUM });
  assert.deepEqual(db.getUserFilters(user.id).categories, ['Tech'], 'adding a keyword keeps topics');

  const done = await fireCallback('filter:done', { from: user, subscription: PREMIUM });
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

  await fireCallback('filter:kw:add', { from: user, subscription: PREMIUM });
  const menuTap = await sendText('⭐ Subscribe', { from: user, subscription: PREMIUM });
  assert.equal(menuTap.passedThrough, true);

  const command = await sendText('/summary', { from: user, subscription: PREMIUM });
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

  const inGroup = { from: user, chatType: 'supergroup', subscription: PREMIUM };
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
  const dm = await run('filter', { from: user, subscription: PREMIUM, text: '/filter' });
  assert.match(dm.replies[0], /severance package/);
});

test('a stray keyword callback from a group cannot edit anything', async () => {
  const user = newUser(817, 'Forged');
  db.setUserFilters(user.id, { keywords: ['alpha'], categories: [] });
  const row = await keywordButton(user, /alpha/);

  const inGroup = { from: user, chatType: 'supergroup', subscription: PREMIUM };
  const toggled = await fireCallback(row, inGroup);
  assert.equal(toggled.edits.length, 0);

  const removed = await fireCallback('filter:kw:remove', inGroup);
  assert.equal(removed.edits.length, 0);
  assert.deepEqual(db.getUserFilters(user.id).keywords, ['alpha'], 'and nothing was removed');
});

test('cancelling the prompt, or walking back to topics, leaves the next message alone', async () => {
  const user = newUser(814, 'Canceller');

  await fireCallback('filter:kw:add', { from: user, subscription: PREMIUM });
  const cancelled = await fireCallback('filter:kw:addcancel', { from: user, subscription: PREMIUM });
  assert.match(cancelled.edits[0], /Cancelled/i);
  assert.equal((await sendText('@ignored', { from: user, subscription: PREMIUM })).passedThrough, true);

  // Back does the same: leaving the screen abandons the question it asked.
  await fireCallback('filter:kw:add', { from: user, subscription: PREMIUM });
  await fireCallback('filter:back', { from: user, subscription: PREMIUM });
  assert.equal((await sendText('also ignored', { from: user, subscription: PREMIUM })).passedThrough, true);
  assert.equal(db.getUserFilters(user.id).keywords.length, 0);
});

test('the free plan includes one keyword, and the second is an upsell', async () => {
  // Free is one rather than zero for the same reason channels are: a feature
  // you use and outgrow beats one you only ever meet as a paywall.
  const user = newUser(820, 'Free');

  await fireCallback('filter:kw:add', { from: user });
  const first = await sendText('deploy', { from: user });
  assert.deepEqual(db.getUserFilters(user.id).keywords, ['deploy'], 'the first one is free');
  assert.match(first.replies[0], /Added: deploy/);

  const blocked = await fireCallback('filter:kw:add', { from: user });
  assert.match(blocked.replies.join('\n'), /free plan includes 1 keyword/i);
  assert.match(blocked.replies.join('\n'), /subscribe/i);

  // The prompt was never armed, so the next message stays an ordinary one.
  const after = await sendText('another', { from: user });
  assert.equal(after.passedThrough, true);
  assert.deepEqual(db.getUserFilters(user.id).keywords, ['deploy']);
});

test('a free user sending several at once gets the first and an upsell for the rest', async () => {
  const user = newUser(821, 'Eager');

  await fireCallback('filter:kw:add', { from: user });
  const ctx = await sendText('alpha, beta, gamma', { from: user });

  assert.deepEqual(db.getUserFilters(user.id).keywords, ['alpha'], 'one lands');
  const said = ctx.replies.join('\n');
  assert.match(said, /Added: alpha/);
  assert.match(said, /beta, gamma/, 'the rest are named, not dropped in silence');
  assert.match(said, /subscribe/i);
});

test('hitting the keyword wall is counted as a paywall moment, not a generic limit', async () => {
  // This is the number that says whether gating keywords was worth doing, so
  // it has to land in the same funnel as the other free-plan walls.
  const { EVENTS, getFunnelReport } = require('../src/services/analytics');
  const user = newUser(822, 'Counted');
  db.setUserFilters(user.id, { keywords: ['taken'], categories: [] });

  const before = getFunnelReport(1).paywallHitUsers;
  await fireCallback('filter:kw:add', { from: user });

  const events = db.db
    .prepare('SELECT event_type FROM events WHERE user_id = ?')
    .all(user.id)
    .map((r) => r.event_type);
  assert.ok(events.includes(EVENTS.FILTER_BLOCKED_PREMIUM));
  assert.equal(
    getFunnelReport(1).paywallHitUsers,
    before + 1,
    'and it reaches the paywall -> purchase conversion rate, which is the point of gating it'
  );

  // A paying user filling their twenty is housekeeping, not a paywall.
  const premium = newUser(823, 'Paying');
  db.setUserFilters(premium.id, {
    keywords: Array.from({ length: MAX_KEYWORDS }, (_, i) => `w${i}`),
    categories: [],
  });
  const atCeiling = await fireCallback('filter:kw:add', { from: premium, subscription: PREMIUM });
  const said = atCeiling.replies.join('\n');
  assert.match(said, /already following 20 keywords/i);
  assert.ok(!/subscribe/i.test(said), 'a paying user must not be asked to subscribe');
});

test('a lapsed subscriber keeps every keyword, and the first one still matches', async () => {
  // Deleting the rest would be the one irreversible way to handle a lapse.
  const user = newUser(824, 'Lapsed');
  db.setUserFilters(user.id, { keywords: ['kept', 'locked'], categories: [] });

  const stored = db.getUserFilters(user.id);
  assert.equal(stored.keywords.length, 2, 'nothing was deleted');

  const free = buildFilterMatcher({
    ...stored,
    keywords: allowedKeywords(stored.keywords, FREE_LIMITS.maxKeywords),
  });
  assert.equal(free('the kept one'), true, 'their earliest keyword still works');
  assert.equal(free('the locked one'), false, 'the rest do not match until they resubscribe');

  const premium = buildFilterMatcher({
    ...stored,
    keywords: allowedKeywords(stored.keywords, PREMIUM_LIMITS.maxKeywords),
  });
  assert.equal(premium('the locked one'), true, 'and come straight back when they do');
});

test('locked keywords are marked, explained, and can still be removed', async () => {
  const user = newUser(825, 'Marked');
  db.setUserFilters(user.id, { keywords: ['live', 'dormant'], categories: [] });

  const screen = await fireCallback('filter:keywords', { from: user });
  const locked = buttons(screen).filter((l) => l.includes('🔒'));
  assert.equal(locked.length, 1, 'exactly the one past the free allowance');
  assert.ok(locked[0].includes('dormant'));
  assert.match(screen.edits[0], /free plan/i, 'and the screen says why');

  // The way out of "you follow more than your plan matches" is removing one.
  const row = await keywordButton(user, /dormant/, null);
  await fireCallback(row, { from: user });
  await fireCallback('filter:kw:remove', { from: user });
  assert.deepEqual(db.getUserFilters(user.id).keywords, ['live']);
});

test('the topics screen marks a locked keyword too, so it never looks active', async () => {
  const user = newUser(826, 'Consistent');
  db.setUserFilters(user.id, { keywords: ['live', 'dormant'], categories: [] });

  const free = await run('filter', { from: user, text: '/filter' });
  assert.match(free.replies[0], /🔒 dormant/, 'the locked one is marked wherever it is listed');
  assert.ok(!/🔒 live/.test(free.replies[0]), 'the live one is not');

  const paid = await run('filter', { from: user, subscription: PREMIUM, text: '/filter' });
  assert.ok(!paid.replies[0].includes('🔒'), 'and nothing is locked once they pay');
});

test('a keyword is highlighted in a digest the same way a category is', async () => {
  // The point of the whole screen: what you type here has to reach the matcher
  // that digest.js runs over every message in the window.
  const user = newUser(815, 'Endtoend');

  await fireCallback('filter:kw:add', { from: user, subscription: PREMIUM });
  await sendText('квартальный отчёт', { from: user, subscription: PREMIUM });

  const matches = buildFilterMatcher(db.getUserFilters(user.id));
  assert.equal(matches('прислали квартальный отчет по продажам'), true, 'ё and е are the same word');
  assert.equal(matches('годовой отчет'), false);
});

test('the alerts row switches on, and stays on', async () => {
  // The button was drawn for months before anything was listening to it:
  // toggleAlerts existed, the keyboard emitted filter:alerts:toggle, and no
  // bot.action() ever claimed it, so tapping it did nothing at all.
  const user = newUser(816, 'Alerts');
  db.setUserFilters(user.id, { keywords: ['zebra'], categories: [] });

  const before = await fireCallback('filter:keywords', { from: user, subscription: PREMIUM });
  assert.ok(
    buttons(before).some((l) => /Alerts: off/i.test(l)),
    'never on by default — this is the thing that turns the bot into something that messages you'
  );

  const on = await fireCallback('filter:alerts:toggle', { from: user, subscription: PREMIUM });
  assert.equal(db.db.prepare('SELECT alerts_enabled FROM users WHERE id = ?').get(user.id).alerts_enabled, 1);
  assert.equal(alerts.isSubscribed(user.id), true, 'and the delivery path agrees, not just the row');
  assert.ok(buttons(on).some((l) => /Alerts: ON/.test(l)), 'the keyboard redraws in the new state');

  const off = await fireCallback('filter:alerts:toggle', { from: user, subscription: PREMIUM });
  assert.equal(db.db.prepare('SELECT alerts_enabled FROM users WHERE id = ?').get(user.id).alerts_enabled, 0);
  assert.equal(alerts.isSubscribed(user.id), false);
  assert.ok(buttons(off).some((l) => /Alerts: off/i.test(l)), 'one tap in each direction');
});

test('a free plan is told why rather than silently ignored', async () => {
  const user = newUser(817, 'Free');
  db.setUserFilters(user.id, { keywords: ['zebra'], categories: [] });

  const view = await fireCallback('filter:keywords', { from: user });
  assert.ok(!buttons(view).some((l) => /Alerts:/i.test(l)), 'the row is absent, not present-and-refusing');

  // Reachable anyway from a keyboard drawn before the subscription lapsed.
  await fireCallback('filter:alerts:toggle', { from: user });
  assert.equal(db.db.prepare('SELECT alerts_enabled FROM users WHERE id = ?').get(user.id).alerts_enabled, 0);
});

test('every button the filter screens draw has something listening to it', async () => {
  // The general form of the bug above. A callback_data with no registered
  // handler is invisible in review and silent in production: Telegram shows a
  // spinner, the spinner stops, nothing happens, and nothing is logged.
  const user = newUser(818, 'Wiring');
  db.setUserFilters(user.id, { keywords: ['zebra'], categories: ['news'] });
  alerts.setSubscribed(user.id, false);

  const screens = [
    await run('filter', { from: user, subscription: PREMIUM, text: '/filter' }),
    await fireCallback('filter:keywords', { from: user, subscription: PREMIUM }),
  ];
  // With a row ticked, so the remove button is drawn too.
  const rowId = callbackFor(screens[1], /zebra/);
  screens.push(await fireCallback(rowId, { from: user, subscription: PREMIUM }));

  const seen = new Set();
  for (const ctx of screens) {
    for (const markup of ctx.markups) {
      for (const button of markup.inline_keyboard.flat()) {
        if (button.callback_data) seen.add(button.callback_data);
      }
    }
  }
  assert.ok(seen.has('filter:alerts:toggle'), 'the toggle is among the buttons actually checked');

  const orphans = [...seen].filter(
    (data) => !handlers.actions.some(({ pattern }) => matchAction(pattern, data))
  );
  assert.deepEqual(orphans, [], 'these buttons are drawn but do nothing when tapped');

  for (const data of seen) {
    assert.ok(Buffer.byteLength(data) <= 64, `${data} is over Telegram's 64-byte callback_data cap`);
  }
});
