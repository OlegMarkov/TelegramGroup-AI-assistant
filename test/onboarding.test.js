const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-onboarding-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

// Patched before the commands are loaded, so their destructured imports pick
// up the stubs. Nothing in this file touches the network. Modeled on
// test/channels.test.js.
const channelSource = require('../src/services/channelSource');
const UNAVAILABLE_HANDLE = 'nopreviewchan';
channelSource.resolveChannel = async (handle) => {
  if (handle === UNAVAILABLE_HANDLE) throw new channelSource.ChannelUnavailableError(handle);
  return { handle: String(handle).toLowerCase(), title: `Title of ${handle}` };
};
channelSource.fetchChannelPosts = async () => ({
  title: 'Stub Channel',
  posts: [{ id: 1, text: 'A post worth summarizing', createdAt: new Date().toISOString() }],
});

const deepseek = require('../src/services/deepseek');
deepseek.summarize = async () => 'stub summary';

const db = require('../src/services/database');
const { track, EVENTS, getActivationReport } = require('../src/services/analytics');
const { FREE_LIMITS } = require('../src/models/subscription');
const { t, SUPPORTED_LANGUAGES } = require('../src/utils/i18n');

const registerStart = require('../src/commands/start');
// The register function and its named helpers (needsOnboarding, welcomeAdder,
// offerReferringGroup) live on the same module.exports object, like channel.js.
const onboarding = require('../src/commands/onboarding');
const registerSummary = require('../src/commands/summary');

// --- one shared fakeBot, exactly the way bot.js wires start, onboarding and
// summary onto the same instance --------------------------------------------

const handlers = { start: null, actions: [], text: null };
const fakeBot = {
  start(fn) {
    handlers.start = fn;
  },
  command() {},
  hears() {},
  action(pattern, fn) {
    handlers.actions.push({ pattern, fn });
  },
  on(event, fn) {
    if (event === 'text') handlers.text = fn;
  },
};
registerStart(fakeBot);
onboarding(fakeBot);
registerSummary(fakeBot);

test.after(() => {
  db.db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

// --- ctx helpers -------------------------------------------------------

let nextChatId = 1;
function makeCtx({
  from,
  subscription,
  text,
  chatType = 'private',
  lang = 'en',
  botUsername = 'onboardingbot',
  canReadAll,
  sendMessageImpl,
} = {}) {
  const replies = [];
  const edits = [];
  const cbAnswers = [];
  const markups = [];
  const sent = []; // DMs sent via ctx.telegram.sendMessage
  const record = (extra) => {
    if (extra && extra.reply_markup) markups.push(extra.reply_markup);
  };
  return {
    chat: from ? { id: chatType === 'private' ? from.id : nextChatId--, type: chatType } : undefined,
    from,
    state: { subscription: subscription || null, lang },
    message: text !== undefined ? { text, message_id: 1, date: Math.floor(Date.now() / 1000) } : undefined,
    botInfo:
      botUsername === null
        ? undefined
        : { username: botUsername, can_read_all_group_messages: canReadAll === undefined ? true : canReadAll },
    replies,
    edits,
    cbAnswers,
    markups,
    sent,
    telegram: {
      sendMessage: async (userId, msg, extra) => {
        if (sendMessageImpl) return sendMessageImpl(userId, msg, extra);
        sent.push({ userId, msg, extra });
        return { message_id: 1 };
      },
    },
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
    answerCbQuery: async (msg) => {
      cbAnswers.push(msg || '');
    },
  };
}

/** Labels of the last keyboard drawn, flattened across rows. */
function buttons(ctx) {
  const markup = ctx.markups[ctx.markups.length - 1];
  if (!markup) return [];
  return markup.inline_keyboard.flat().map((b) => b.text);
}

function buttonData(ctx, matcher) {
  const markup = ctx.markups[ctx.markups.length - 1];
  const button = markup.inline_keyboard.flat().find((b) => matcher.test(b.text));
  // URL buttons (e.g. "add me to a group") carry `url`, not `callback_data`.
  return button && (button.callback_data || button.url);
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

/** A plain private message, as it reaches onboarding's captureReply. */
async function sendText(text, opts) {
  const ctx = makeCtx({ ...opts, text });
  ctx.passedThrough = false;
  await handlers.text(ctx, async () => {
    ctx.passedThrough = true;
  });
  return ctx;
}

async function start(userId, opts = {}) {
  db.getOrCreateUser({ id: userId, username: `u${userId}`, firstName: 'New' });
  const ctx = makeCtx({ from: { id: userId, first_name: 'New' }, text: opts.text || '/start', ...opts });
  await handlers.start(ctx);
  return ctx;
}

function eventRows(userId, type) {
  return db.db
    .prepare('SELECT chat_id, metadata FROM events WHERE user_id = ? AND event_type = ? ORDER BY id')
    .all(userId, type);
}

// =========================================================================
// /start: first-time vs. returning, in a group, and via referral
// =========================================================================

test('a brand-new private /start gets the short welcome, then the first-run question', async () => {
  const ctx = await start(9600);

  assert.equal(ctx.replies.length, 2, 'the welcome and the question are two separate messages');
  assert.match(ctx.replies[0], /I read busy chats/);
  assert.match(ctx.replies[1], /What do you want to catch up on/);
  assert.deepEqual(buttons(ctx), [t('en', 'onboarding.groupButton'), t('en', 'onboarding.channelButton'), t('en', 'onboarding.exampleButton')]);
});

test('a returning user with a group already gets only the welcome-back message', async () => {
  const userId = 9601;
  db.getOrCreateUser({ id: userId, firstName: 'Returning' });
  db.getOrCreateChat({ id: -9601, title: 'Their group', type: 'supergroup' });
  db.linkUserToChat(-9601, userId);

  const ctx = await start(userId);
  assert.equal(ctx.replies.length, 1, 'no question is asked once there is something to summarize already');
  assert.match(ctx.replies[0], /Welcome back/);
});

test('a returning user with only a channel also skips the question', async () => {
  const userId = 9602;
  db.getOrCreateUser({ id: userId, firstName: 'ChannelOnly' });
  const chan = db.getOrCreateChannel({ username: 'startchan', title: 'Start Chan' });
  db.linkUserToChat(chan.id, userId);

  const ctx = await start(userId);
  assert.equal(ctx.replies.length, 1);
  assert.match(ctx.replies[0], /Welcome back/);
});

test('/start in a group with the add-to-group payload (the link arriving) replies nothing', async () => {
  const userId = 9603;
  const ctx = await start(userId, { chatType: 'supergroup', text: `/start ${onboarding.ADD_TO_GROUP_PAYLOAD}` });
  assert.equal(ctx.replies.length, 0);
});

test('/start in a group with no payload points at /summary instead of onboarding', async () => {
  const userId = 9604;
  const ctx = await start(userId, { chatType: 'supergroup', text: '/start' });
  assert.equal(ctx.replies.length, 1);
  assert.match(ctx.replies[0], /\/summary/);
});

test('/start in a group with any other payload (e.g. a referral link typed there) still replies, not silently swallowed', async () => {
  const userId = 9608;
  const ctx = await start(userId, { chatType: 'supergroup', text: '/start g-100999' });
  assert.equal(ctx.replies.length, 1);
  assert.match(ctx.replies[0], /\/summary/);
});

test('a referral link to a group the user is already linked to offers that group instead of the question', async () => {
  const userId = 9605;
  const chatId = -9605;
  db.getOrCreateChat({ id: chatId, title: 'Referring Group', type: 'supergroup' });
  db.getOrCreateUser({ id: userId, firstName: 'Member' });
  db.linkUserToChat(chatId, userId); // already a member, so this is not a first-run user

  const ctx = await start(userId, { text: `/start g${chatId}` });

  assert.equal(ctx.replies.length, 2, 'welcome-back, then the group offer');
  assert.match(ctx.replies[0], /Welcome back/);
  assert.match(ctx.replies[1], /Referring Group/);
  assert.equal(buttonData(ctx, /Referring Group/), `summary:chat:${chatId}:auto`);
  assert.ok(!ctx.replies.some((r) => /What do you want to catch up on/.test(r)), 'the question is skipped');
});

test('a first-run user re-linked to a deactivated referring group still gets the offer, not the question', async () => {
  // Rejoin case: the chat_members row survived the bot being removed and
  // re-added, but the chat itself is inactive, so needsOnboarding still says
  // "new" — the offer must still win over the question.
  const userId = 9606;
  const chatId = -9606;
  db.getOrCreateChat({ id: chatId, title: 'Rejoined Group', type: 'supergroup' });
  db.getOrCreateUser({ id: userId, firstName: 'Rejoiner' });
  db.linkUserToChat(chatId, userId);
  db.deactivateChat(chatId);
  assert.equal(db.getUserGroups(userId).length, 0, 'sanity: an inactive chat does not count toward "has a group"');

  const ctx = await start(userId, { text: `/start g${chatId}` });

  assert.equal(ctx.replies.length, 2);
  assert.match(ctx.replies[0], /I read busy chats/, 'the first-run welcome, not welcome-back');
  assert.match(ctx.replies[1], /Rejoined Group/);
  assert.ok(!ctx.replies.some((r) => /What do you want to catch up on/.test(r)));
});

test('a referral to a group the user is not linked to falls back to the ordinary question', async () => {
  const userId = 9607;
  const chatId = -9607;
  db.getOrCreateChat({ id: chatId, title: 'Someone Elses Group', type: 'supergroup' });

  const ctx = await start(userId, { text: `/start g${chatId}` });

  assert.equal(ctx.replies.length, 2);
  assert.match(ctx.replies[0], /I read busy chats/);
  assert.match(ctx.replies[1], /What do you want to catch up on/);
  assert.ok(!ctx.replies.some((r) => /Someone Elses Group/.test(r)));
});

// =========================================================================
// needsOnboarding
// =========================================================================

test('needsOnboarding is true only while a user has neither a group nor a channel', () => {
  const userId = 9610;
  db.getOrCreateUser({ id: userId, firstName: 'Empty' });
  assert.equal(onboarding.needsOnboarding(userId), true);

  const chan = db.getOrCreateChannel({ username: 'needschan', title: 'Needs Chan' });
  db.linkUserToChat(chan.id, userId);
  assert.equal(onboarding.needsOnboarding(userId), false);
});

// =========================================================================
// The four callbacks
// =========================================================================

test('onb:group tracks the path, offers the add-to-group link, and clears any armed channel prompt', async () => {
  const user = { id: 9620, first_name: 'Grouper' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });

  // Arm the channel prompt first, so we can prove it gets cleared.
  await fireCallback('onb:channel', { from: user });

  const ctx = await fireCallback('onb:group', { from: user });
  assert.deepEqual(eventRows(user.id, EVENTS.ONBOARDING_PATH_CHOSEN).map((r) => JSON.parse(r.metadata).path).slice(-1), ['group']);
  assert.match(ctx.replies[0], /Add me to your group/);
  assert.match(buttonData(ctx, /Add me to a group/), new RegExp(`t\\.me/onboardingbot\\?startgroup=onboarding`));

  // The channel prompt is gone: a plain message now passes through instead
  // of being treated as a channel name.
  const after = await sendText('just chatting', { from: user });
  assert.equal(after.passedThrough, true);
});

test('onb:group omits the button when the bot has no username yet (only a test lacks one)', async () => {
  const user = { id: 9621, first_name: 'NoUsername' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });

  const ctx = await fireCallback('onb:group', { from: user, botUsername: null });
  assert.match(ctx.replies[0], /Add me to your group/);
  assert.equal(ctx.markups.length, 0, 'no keyboard at all without a link to put on it');
});

test('onb:channel tracks the path, arms the prompt, and offers a Back button', async () => {
  const user = { id: 9622, first_name: 'Channeler' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });

  const ctx = await fireCallback('onb:channel', { from: user });
  assert.deepEqual(eventRows(user.id, EVENTS.ONBOARDING_PATH_CHOSEN).map((r) => JSON.parse(r.metadata).path), ['channel']);
  assert.match(ctx.replies[0], /Send me a public channel/);
  assert.deepEqual(buttons(ctx), [t('en', 'onboarding.backButton')]);

  // The prompt is armed: the next plain message is taken as a channel name.
  const answered = await sendText('@primed_channel', { from: user });
  assert.equal(answered.passedThrough, false);
  assert.deepEqual(db.getUserChannels(user.id).map((c) => c.username), ['primed_channel']);
});

test('onb:example tracks the path, clears the channel prompt, and hides its own button', async () => {
  const user = { id: 9623, first_name: 'Exampler' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });
  await fireCallback('onb:channel', { from: user }); // arm it first

  const ctx = await fireCallback('onb:example', { from: user });
  assert.deepEqual(
    eventRows(user.id, EVENTS.ONBOARDING_PATH_CHOSEN)
      .map((r) => JSON.parse(r.metadata).path)
      .slice(-1),
    ['example']
  );
  assert.match(ctx.replies[0], /made-up chat, not your data/);
  const labels = buttons(ctx);
  assert.ok(labels.includes(t('en', 'onboarding.groupButton')));
  assert.ok(labels.includes(t('en', 'onboarding.channelButton')));
  assert.ok(!labels.includes(t('en', 'onboarding.exampleButton')), 'no point offering the example again');

  const after = await sendText('just chatting', { from: user });
  assert.equal(after.passedThrough, true, 'the channel prompt was cleared');
});

test('onb:back clears the prompt and redraws the original question in place', async () => {
  const user = { id: 9624, first_name: 'Backer' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });
  await fireCallback('onb:channel', { from: user });

  const ctx = await fireCallback('onb:back', { from: user });
  assert.equal(ctx.edits.length, 1);
  assert.match(ctx.edits[0], /What do you want to catch up on/);
  assert.deepEqual(buttons(ctx), [
    t('en', 'onboarding.groupButton'),
    t('en', 'onboarding.channelButton'),
    t('en', 'onboarding.exampleButton'),
  ]);

  const after = await sendText('just chatting', { from: user });
  assert.equal(after.passedThrough, true, 'the channel prompt no longer swallows this message');
});

test('onb:back does not throw when the edit fails (message too old, or already changed)', async () => {
  const user = { id: 9625, first_name: 'StaleEditor' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });

  const ctx = await fireCallback('onb:back', { from: user });
  ctx.editMessageText = async () => {
    throw new Error('message to edit not found');
  };
  // Fire again directly through the handler with the failing ctx.
  for (const { pattern, fn } of handlers.actions) {
    if (pattern === 'onb:back') {
      await assert.doesNotReject(() => fn(ctx));
    }
  }
});

// =========================================================================
// The channel answer: happy path, limits, and failures
// =========================================================================

test('answering the channel prompt follows it and summarizes it right away, within the plan lookback', async () => {
  const user = { id: 9630, first_name: 'Answerer' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });
  await fireCallback('onb:channel', { from: user });

  const ctx = await sendText('@durov', { from: user });

  assert.deepEqual(db.getUserChannels(user.id).map((c) => c.username), ['durov']);
  assert.equal(db.getSummaryUsageToday(user.id), 1, 'went through the real daily-summary gate, not a shortcut');
  assert.ok(ctx.replies.some((r) => /Following/.test(r)), 'the channel-added confirmation');
  assert.ok(ctx.replies.some((r) => /stub summary/.test(r)), 'the summary was actually delivered');
  assert.ok(ctx.replies.some((r) => /\/summary whenever you want/.test(r)), 'the next-step message');
  assert.match(buttonData(ctx, /Add me to a group/) || '', /startgroup=onboarding/);
});

test('a free user already at the daily summary limit still gets the channel, but a blocked summary', async () => {
  const user = { id: 9631, first_name: 'Capped' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });
  for (let i = 0; i < FREE_LIMITS.maxSummariesPerDay; i += 1) db.incrementSummaryUsage(user.id);

  await fireCallback('onb:channel', { from: user });
  const ctx = await sendText('@capped_onboarding_chan', { from: user });

  assert.deepEqual(db.getUserChannels(user.id).map((c) => c.username), ['capped_onboarding_chan'], 'the channel is still added');
  assert.ok(!ctx.replies.some((r) => /stub summary/.test(r)), 'no summary was produced');
  assert.match(ctx.replies.join('\n'), /free summaries/i);
  assert.ok(ctx.replies.some((r) => /\/summary whenever you want/.test(r)), 'the flow still finishes');
});

test('an invalid handle at the channel prompt keeps it armed for a retry', async () => {
  const user = { id: 9632, first_name: 'Typo' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });
  await fireCallback('onb:channel', { from: user });

  const typo = await sendText('h', { from: user });
  assert.match(typo.replies[0], /doesn't look like a channel/i);
  assert.equal(db.getUserChannels(user.id).length, 0);

  const retry = await sendText('@retry_onboarding_chan', { from: user });
  assert.equal(retry.passedThrough, false, 'still waiting, no second tap needed');
  assert.deepEqual(db.getUserChannels(user.id).map((c) => c.username), ['retry_onboarding_chan']);
});

test('an unavailable channel re-offers the path keyboard instead of leaving the prompt armed', async () => {
  const user = { id: 9633, first_name: 'Unavailable' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });
  await fireCallback('onb:channel', { from: user });

  const ctx = await sendText(UNAVAILABLE_HANDLE, { from: user });
  assert.match(ctx.replies.join('\n'), /can't read/i);
  assert.match(ctx.replies[ctx.replies.length - 1], /Want to try something else/i);
  assert.deepEqual(buttons(ctx), [
    t('en', 'onboarding.groupButton'),
    t('en', 'onboarding.channelButton'),
    t('en', 'onboarding.exampleButton'),
  ]);
  assert.equal(db.getUserChannels(user.id).length, 0);

  // And the prompt is not left armed on this path: a plain message now
  // passes through rather than being retried as a channel name.
  const after = await sendText('just chatting', { from: user });
  assert.equal(after.passedThrough, true);
});

test('hitting the channel allowance at the prompt also re-offers the path keyboard', async () => {
  const user = { id: 9634, first_name: 'AtChannelCap' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });
  const already = db.getOrCreateChannel({ username: 'already_following', title: 'Already' });
  db.linkUserToChat(already.id, user.id); // fills the free plan's one channel slot

  await fireCallback('onb:channel', { from: user });
  const ctx = await sendText('@one_more_onboarding_chan', { from: user });

  assert.match(ctx.replies.join('\n'), /free plan includes/i);
  assert.match(ctx.replies[ctx.replies.length - 1], /Want to try something else/i);
  assert.deepEqual(
    db.getUserChannels(user.id).map((c) => c.username),
    ['already_following'],
    'nothing new was added'
  );
});

// =========================================================================
// welcomeAdder
// =========================================================================

function chatRow(id, title) {
  return db.getOrCreateChat({ id, title, type: 'supergroup' });
}

test('welcomeAdder DMs whoever added the bot, naming the group', async () => {
  const chat = chatRow(-9700, 'Adder Group');
  const ctx = makeCtx({});
  const ok = await onboarding.welcomeAdder(ctx, chat, { id: 5001, first_name: 'Adder' });

  assert.equal(ok, true);
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.sent[0].userId, 5001);
  assert.match(ctx.sent[0].msg, /Adder Group/);
  assert.ok(!ctx.sent[0].msg.includes('Make me an admin'), 'no privacy note when the bot already sees everything');
});

test('welcomeAdder skips a bot adder entirely', async () => {
  const chat = chatRow(-9701, 'Bot Adder Group');
  const ctx = makeCtx({});
  const ok = await onboarding.welcomeAdder(ctx, chat, { id: 5002, first_name: 'BotAdder', is_bot: true });

  assert.equal(ok, false);
  assert.equal(ctx.sent.length, 0);
});

test('welcomeAdder is throttled to once per 24h per chat, however many times it is re-added', async () => {
  const chat = chatRow(-9702, 'Repeat Adder Group');
  const ctx1 = makeCtx({});
  assert.equal(await onboarding.welcomeAdder(ctx1, chat, { id: 5003, first_name: 'First' }), true);

  const ctx2 = makeCtx({});
  assert.equal(await onboarding.welcomeAdder(ctx2, chat, { id: 5004, first_name: 'Second' }), false, 'still within the window');
  assert.equal(ctx2.sent.length, 0);

  // Older than the throttle: it fires again.
  db.db.prepare("UPDATE chats SET adder_welcomed_at = datetime('now', '-25 hours') WHERE id = ?").run(chat.id);
  const ctx3 = makeCtx({});
  assert.equal(await onboarding.welcomeAdder(ctx3, chat, { id: 5005, first_name: 'Third' }), true);
  assert.equal(ctx3.sent.length, 1);
});

test('welcomeAdder adds the privacy-mode note only without all-messages access and without admin', async () => {
  const noAccess = chatRow(-9703, 'Privacy Mode Group');
  const ctxNoAdmin = makeCtx({ canReadAll: false });
  await onboarding.welcomeAdder(ctxNoAdmin, noAccess, { id: 5006, first_name: 'A' }, { isAdmin: false });
  assert.match(ctxNoAdmin.sent[0].msg, /Make me an admin/);

  const asAdmin = chatRow(-9704, 'Privacy Mode But Admin');
  const ctxAdmin = makeCtx({ canReadAll: false });
  await onboarding.welcomeAdder(ctxAdmin, asAdmin, { id: 5007, first_name: 'B' }, { isAdmin: true });
  assert.ok(!ctxAdmin.sent[0].msg.includes('Make me an admin'), 'an admin already sees everything');

  const fullAccess = chatRow(-9705, 'Full Access Group');
  const ctxFull = makeCtx({ canReadAll: true });
  await onboarding.welcomeAdder(ctxFull, fullAccess, { id: 5008, first_name: 'C' }, { isAdmin: false });
  assert.ok(!ctxFull.sent[0].msg.includes('Make me an admin'));

  const noBotInfo = chatRow(-9706, 'No BotInfo Group');
  const ctxNoBotInfo = makeCtx({ botUsername: null });
  ctxNoBotInfo.botInfo = undefined;
  await onboarding.welcomeAdder(ctxNoBotInfo, noBotInfo, { id: 5009, first_name: 'D' }, { isAdmin: false });
  assert.ok(!ctxNoBotInfo.sent[0].msg.includes('Make me an admin'), 'no botInfo defaults to "sees everything"');
});

test('welcomeAdder swallows a failed DM (adder never started the bot) and returns false', async () => {
  const chat = chatRow(-9707, 'Unreachable Adder Group');
  const ctx = makeCtx({ sendMessageImpl: async () => { throw new Error('bot was blocked by the user'); } });

  await assert.doesNotReject(async () => {
    const ok = await onboarding.welcomeAdder(ctx, chat, { id: 5010, first_name: 'Unreachable' });
    assert.equal(ok, false);
  });
});

// =========================================================================
// offerReferringGroup directly (the branch start.js falls back on)
// =========================================================================

test('offerReferringGroup returns false, and sends nothing, when not linked or the chat is unknown', async () => {
  const ctx = makeCtx({ from: { id: 9640 } });
  assert.equal(await onboarding.offerReferringGroup(ctx, -999999, true), false, 'unknown chat id');
  assert.equal(ctx.replies.length, 0);

  const chat = chatRow(-9640, 'Known Group');
  const ctx2 = makeCtx({ from: { id: 9641 } });
  assert.equal(await onboarding.offerReferringGroup(ctx2, chat.id, false), false, 'isLinked flag says no');
  assert.equal(ctx2.replies.length, 0);
});

// =========================================================================
// getActivation / getOnboardingPaths
// =========================================================================

test('getActivation counts a summary within 24h of first start, and excludes users younger than a day', () => {
  const before = db.getActivation(30);

  // A: started 3 days ago, summarized 2h later -> eligible and activated.
  db.getOrCreateUser({ id: 9650, firstName: 'A' });
  track(EVENTS.USER_STARTED, { userId: 9650 });
  db.db
    .prepare("UPDATE events SET created_at = datetime('now', '-3 days') WHERE user_id = 9650 AND event_type = 'user_started'")
    .run();
  track(EVENTS.SUMMARY_COMPLETED, { userId: 9650 });
  db.db
    .prepare(
      "UPDATE events SET created_at = datetime('now', '-3 days', '+2 hours') WHERE user_id = 9650 AND event_type = 'summary_completed'"
    )
    .run();

  // B: started 3 days ago, summarized 2 days later -> eligible, not activated.
  db.getOrCreateUser({ id: 9651, firstName: 'B' });
  track(EVENTS.USER_STARTED, { userId: 9651 });
  db.db
    .prepare("UPDATE events SET created_at = datetime('now', '-3 days') WHERE user_id = 9651 AND event_type = 'user_started'")
    .run();
  track(EVENTS.SUMMARY_COMPLETED, { userId: 9651 });
  db.db
    .prepare("UPDATE events SET created_at = datetime('now', '-1 days') WHERE user_id = 9651 AND event_type = 'summary_completed'")
    .run();

  // C: started 3 days ago, never summarized -> eligible, not activated.
  db.getOrCreateUser({ id: 9652, firstName: 'C' });
  track(EVENTS.USER_STARTED, { userId: 9652 });
  db.db
    .prepare("UPDATE events SET created_at = datetime('now', '-3 days') WHERE user_id = 9652 AND event_type = 'user_started'")
    .run();

  // D: started 2 hours ago -> too young, excluded entirely.
  db.getOrCreateUser({ id: 9653, firstName: 'D' });
  track(EVENTS.USER_STARTED, { userId: 9653 });
  db.db
    .prepare("UPDATE events SET created_at = datetime('now', '-2 hours') WHERE user_id = 9653 AND event_type = 'user_started'")
    .run();

  // E: exists (e.g. spoke in a group once) but never ran /start -> not counted.
  db.getOrCreateUser({ id: 9654, firstName: 'E' });

  const after = db.getActivation(30);
  assert.equal(after.eligible - before.eligible, 3, 'A, B and C are eligible; D is too young, E never started');
  assert.equal(after.activated - before.activated, 1, 'only A got a summary within 24h of starting');
});

test('getActivationReport bundles activation with the onboarding paths', () => {
  const report = getActivationReport(30);
  assert.ok(Number.isFinite(report.eligible));
  assert.ok(Number.isFinite(report.activated));
  assert.ok(Array.isArray(report.paths));
});

test('getOnboardingPaths counts distinct users per path and ignores events outside the window', () => {
  db.getOrCreateUser({ id: 9660, firstName: 'P1' });
  db.getOrCreateUser({ id: 9661, firstName: 'P2' });
  db.getOrCreateUser({ id: 9662, firstName: 'P3' });
  db.getOrCreateUser({ id: 9663, firstName: 'Old' });

  const before = db.getOnboardingPaths(7);

  track(EVENTS.ONBOARDING_PATH_CHOSEN, { userId: 9660, metadata: { path: 'group' } });
  track(EVENTS.ONBOARDING_PATH_CHOSEN, { userId: 9660, metadata: { path: 'group' } }); // taps twice: one user
  track(EVENTS.ONBOARDING_PATH_CHOSEN, { userId: 9661, metadata: { path: 'group' } });
  track(EVENTS.ONBOARDING_PATH_CHOSEN, { userId: 9662, metadata: { path: 'channel' } });
  track(EVENTS.ONBOARDING_PATH_CHOSEN, { userId: 9663, metadata: { path: 'example' } });
  db.db
    .prepare(
      "UPDATE events SET created_at = datetime('now', '-10 days') WHERE user_id = 9663 AND event_type = 'onboarding_path_chosen'"
    )
    .run();

  const after = db.getOnboardingPaths(7);
  const diff = (pathName) =>
    (after.find((p) => p.path === pathName) || { users: 0 }).users - (before.find((p) => p.path === pathName) || { users: 0 }).users;

  assert.equal(diff('group'), 2, 'two distinct users, one of whom tapped twice');
  assert.equal(diff('channel'), 1);
  assert.equal(diff('example'), 0, 'the old event, outside the 7-day window, is not counted');
});

// =========================================================================
// Markdown balance of the new copy, with placeholders filled
// =========================================================================

test('every new onboarding and start string is one balanced, fully-interpolated Telegram message', () => {
  const filled = {
    'start.welcome': { name: 'Alex', trialNote: '\n\nSome trial note *bold*.' },
    'start.welcomeBack': { name: 'Alex', trialNote: '' },
    'start.inGroup': {},
    'onboarding.question': {},
    'onboarding.groupButton': {},
    'onboarding.channelButton': {},
    'onboarding.exampleButton': {},
    'onboarding.backButton': {},
    'onboarding.addToGroupButton': {},
    'onboarding.groupHowTo': {},
    'onboarding.channelPrompt': {},
    'onboarding.channelAdded': { title: 'Some Channel', handle: 'somechannel' },
    'onboarding.channelNext': {},
    'onboarding.tryAnother': {},
    'onboarding.example': {},
    'onboarding.referralOffer': { title: 'Some Group' },
    'onboarding.referralButton': { title: 'Some Group' },
    'onboarding.adderPrivacyMode': { title: 'Some Group' },
  };

  for (const lang of SUPPORTED_LANGUAGES) {
    for (const [key, params] of Object.entries(filled)) {
      const text = t(lang, key, params);
      assert.notEqual(text, key, `no ${lang} copy for ${key}`);
      assert.ok(!text.includes('{'), `${lang} ${key} has an unfilled placeholder`);
      for (const [name, char] of [['bold', '*'], ['code', '`'], ['italic', '_']]) {
        const count = text.split(char).length - 1;
        assert.equal(count % 2, 0, `unbalanced ${name} marker (${char}) in ${lang} ${key}`);
      }
    }

    // adderWelcome is tested with the privacy note both empty and filled,
    // since welcomeAdder concatenates the two into one Markdown message.
    const privacyNote = t(lang, 'onboarding.adderPrivacyMode', { title: 'Some Group' });
    for (const note of ['', `\n\n${privacyNote}`]) {
      const text = t(lang, 'onboarding.adderWelcome', { title: 'Some Group', privacyNote: note });
      assert.ok(!text.includes('{'), `${lang} onboarding.adderWelcome has an unfilled placeholder`);
      for (const [name, char] of [['bold', '*'], ['code', '`'], ['italic', '_']]) {
        const count = text.split(char).length - 1;
        assert.equal(count % 2, 0, `unbalanced ${name} marker (${char}) in ${lang} onboarding.adderWelcome`);
      }
    }
  }
});
