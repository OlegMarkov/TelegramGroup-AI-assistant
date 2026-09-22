const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-onboarding-followup-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';
// scheduler.js -> queue.js opens a real ioredis connection at module load;
// point it at a guaranteed-closed port so it fails fast instead of hanging,
// same as test/scheduler.test.js.
process.env.REDIS_HOST = '127.0.0.1';
process.env.REDIS_PORT = '1';

// Patched before anything in src/ is required, so every module that
// destructures these at load time (digest.js, channel.js) captures the stub.
const channelSource = require('../src/services/channelSource');
channelSource.resolveChannel = async (handle) => ({ handle: String(handle).toLowerCase(), title: `Title of ${handle}` });
channelSource.fetchChannelPosts = async () => ({
  title: 'Stub Channel',
  posts: [{ id: 1, text: 'A post worth summarizing', createdAt: new Date().toISOString() }],
});

const deepseek = require('../src/services/deepseek');
deepseek.summarize = async () => 'stub summary';

// scheduler.js sends DMs via a standalone Telegram client, constructed at
// module load — stub the prototype before scheduler.js is required.
const { Telegram } = require('telegraf');
const sentMessages = [];
const sendScript = new Map();

function scriptSends(chatId, errors) {
  sendScript.set(chatId, [...errors]);
}

function telegramError(code, description) {
  const error = new Error(`${code}: ${description}`);
  error.response = { error_code: code, description };
  error.code = code;
  error.description = description;
  return error;
}

Telegram.prototype.sendMessage = async function (chatId, text, extra) {
  const queued = sendScript.get(chatId);
  const next = queued && queued.length > 0 ? queued.shift() : null;
  if (next) throw next;
  sentMessages.push({ chatId, text, extra });
  return { message_id: 1 };
};

const db = require('../src/services/database');
const { connection } = require('../src/services/queue');
const { track, EVENTS } = require('../src/services/analytics');
const { t, SUPPORTED_LANGUAGES } = require('../src/utils/i18n');
const { FREE_LIMITS, PREMIUM_LIMITS, TRIAL_DAYS, getLimits } = require('../src/models/subscription');

const { grantTrialIfDue, startTrialForRequest } = require('../src/services/trial');
const { addChannelFromInput } = require('../src/commands/channel');
const { buildAndSendSummary } = require('../src/commands/summary');
const onboarding = require('../src/commands/onboarding');
const { buildStatus } = require('../src/commands/status');
const tipsModule = require('../src/commands/tips');
const { pickTip, maybeShowTip } = tipsModule;
const {
  runGroupReadyPings,
  runOnboardingNudges,
  READY_MESSAGES,
  READY_MESSAGES_AFTER_A_DAY,
} = require('../src/services/scheduler');

test.after(async () => {
  db.db.close();
  connection.disconnect();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

// =========================================================================
// ctx helpers, modeled on test/onboarding.test.js
// =========================================================================

function makeCtx({ userId, chatType = 'private', lang = 'en', subscription = null, botUsername = 'bot', canReadAll = true } = {}) {
  const replies = [];
  const markups = [];
  const cbAnswers = [];
  const editedMarkups = [];
  const sent = []; // DMs sent via ctx.telegram.sendMessage, e.g. from welcomeAdder
  const record = (extra) => {
    if (extra && extra.reply_markup) markups.push(extra.reply_markup);
  };
  return {
    chat: { id: userId, type: chatType },
    from: { id: userId, first_name: 'Test' },
    state: { subscription, lang },
    botInfo: { username: botUsername, can_read_all_group_messages: canReadAll },
    telegram: {
      sendMessage: async (toId, msg, extra) => {
        sent.push({ userId: toId, msg, extra });
        return { message_id: 1 };
      },
    },
    replies,
    markups,
    cbAnswers,
    sent,
    reply: async (text, extra) => {
      replies.push(text);
      record(extra);
      return { message_id: 1 };
    },
    answerCbQuery: async (msg) => {
      cbAnswers.push(msg || '');
    },
    editMessageReplyMarkup: async (markup) => {
      editedMarkups.push(markup);
    },
    editedMarkups,
  };
}

function lastMarkup(ctx) {
  return ctx.markups[ctx.markups.length - 1];
}

function buttons(ctx) {
  const markup = lastMarkup(ctx);
  if (!markup) return [];
  return markup.inline_keyboard.flat().map((b) => b.text);
}

function subscriptionRows(userId) {
  return db.db.prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id').all(userId);
}

function backdateEvent(userId, eventType, sqlOffset) {
  db.db
    .prepare(`UPDATE events SET created_at = datetime('now', ?) WHERE user_id = ? AND event_type = ?`)
    .run(sqlOffset, userId, eventType);
}

let uid = 20000;
function nextUserId() {
  return uid++;
}
let cid = -20000;
function nextChatId() {
  return cid--;
}

// =========================================================================
// Trial triggers
// =========================================================================

test('grantTrialIfDue refuses a group member who never started the bot', () => {
  const userId = nextUserId();
  db.getOrCreateUser({ id: userId, firstName: 'Lurker' });
  // Linked to a group by talking in it, but never pressed /start.
  const chatId = nextChatId();
  db.getOrCreateChat({ id: chatId, title: 'Lurker Group', type: 'group' });
  db.linkUserToChat(chatId, userId);

  assert.equal(db.hasUserStarted(userId), false);
  assert.equal(grantTrialIfDue(userId), false);
  assert.equal(subscriptionRows(userId).length, 0);
});

test('grantTrialIfDue grants once someone has started the bot, and refuses a second time', () => {
  const userId = nextUserId();
  db.getOrCreateUser({ id: userId, firstName: 'Started' });
  track(EVENTS.USER_STARTED, { userId });

  assert.equal(grantTrialIfDue(userId), true);
  assert.equal(subscriptionRows(userId).length, 1);
  assert.equal(subscriptionRows(userId)[0].plan, 'trial');

  assert.equal(grantTrialIfDue(userId), false, 'one trial per person, ever');
  assert.equal(subscriptionRows(userId).length, 1);
});

test('startTrialForRequest refreshes ctx.state.subscription so premium limits apply to the same request', () => {
  const userId = nextUserId();
  db.getOrCreateUser({ id: userId, firstName: 'Refreshed' });
  track(EVENTS.USER_STARTED, { userId });

  const ctx = { from: { id: userId }, state: { subscription: null } };
  assert.equal(ctx.state.subscription, null);
  assert.equal(startTrialForRequest(ctx), true);

  assert.ok(ctx.state.subscription, 'the request-scoped state now carries the granted trial');
  assert.equal(getLimits(ctx.state.subscription).scheduledDigests, true);
  assert.equal(getLimits(ctx.state.subscription).maxChannels, PREMIUM_LIMITS.maxChannels);
});

test('a first channel starts the trial, announces it, and the refreshed limits apply within the same request', async () => {
  const userId = nextUserId();
  db.getOrCreateUser({ id: userId, firstName: 'Channeler' });
  track(EVENTS.USER_STARTED, { userId });

  const ctx = makeCtx({ userId });
  const added = await addChannelFromInput(ctx, 'firstchan');
  assert.ok(added, 'the channel was added');

  assert.equal(subscriptionRows(userId).length, 1);
  assert.match(ctx.replies[ctx.replies.length - 1], new RegExp(`${TRIAL_DAYS}-day free trial`));
  assert.ok(ctx.state.subscription, 'refreshed for the very same request');

  // Free plan allows exactly one channel; a second /addchannel in the same
  // request only succeeds because ctx.state.subscription was refreshed.
  const secondAdded = await addChannelFromInput(ctx, 'secondchan');
  assert.ok(secondAdded, 'the refreshed premium limit let a second channel through in the same request');
});

test('a second channel does not announce a trial again', async () => {
  const userId = nextUserId();
  db.getOrCreateUser({ id: userId, firstName: 'Channeler2' });
  track(EVENTS.USER_STARTED, { userId });

  const ctx = makeCtx({ userId });
  await addChannelFromInput(ctx, 'onlychan');
  assert.equal(subscriptionRows(userId).length, 1);

  const before = ctx.replies.length;
  await addChannelFromInput(ctx, 'onlychan2');
  const newReplies = ctx.replies.slice(before);
  assert.ok(!newReplies.some((r) => /free trial/.test(r)), 'no second trial announcement');
  assert.equal(subscriptionRows(userId).length, 1);
});

test('asking for a DM summary starts the trial, and the very same request gets the premium lookback', async () => {
  const userId = nextUserId();
  const chatId = nextChatId();
  db.getOrCreateUser({ id: userId, firstName: 'Summarizer' });
  track(EVENTS.USER_STARTED, { userId });
  db.getOrCreateChat({ id: chatId, title: 'Their Group', type: 'group' });
  db.linkUserToChat(chatId, userId);
  db.saveMessage({ chatId, messageId: 1, userId, username: 'u', text: 'something worth summarizing' });

  const ctx = makeCtx({ userId, chatType: 'private' });
  // Free's cap is 24h; premium's is 72h. Asking for 50 only stays uncapped if
  // the trial granted moments earlier is what buildAndSendSummary reads back.
  await buildAndSendSummary(ctx, chatId, 50);

  assert.equal(subscriptionRows(userId).length, 1);
  assert.match(ctx.replies[0], /free trial/, 'the trial is announced before the summary is built');
  const workingText = ctx.replies.find((r) => /50h/.test(r) || /50 h/.test(r)) || ctx.replies[1];
  assert.ok(!/capped/.test(workingText), 'the premium limit, not the free one, applied to this very request');
});

test('a summary request in a group does not announce a trial (DM only)', async () => {
  const userId = nextUserId();
  const chatId = userId * -1 - 1; // any group id, distinct from the chat being summarized
  db.getOrCreateUser({ id: userId, firstName: 'GroupAsker' });
  track(EVENTS.USER_STARTED, { userId });
  db.getOrCreateChat({ id: chatId, title: 'A Group', type: 'group' });
  db.linkUserToChat(chatId, userId);
  db.saveMessage({ chatId, messageId: 1, userId, username: 'u', text: 'hello there' });

  const ctx = makeCtx({ userId, chatType: 'group' });
  await buildAndSendSummary(ctx, chatId, 24);

  assert.equal(subscriptionRows(userId).length, 0, 'granting it silently in a group would waste it unannounced');
  assert.ok(!ctx.replies.some((r) => /free trial/.test(r)));
});

test('welcomeAdder grants no trial when the join itself is throttled, but does on the next trigger', async () => {
  const chatId = nextChatId();
  const adderId = nextUserId();
  const chat = db.getOrCreateChat({ id: chatId, title: 'Throttled Adder Group', type: 'supergroup' });
  db.getOrCreateUser({ id: adderId, firstName: 'Adder' });
  track(EVENTS.USER_STARTED, { userId: adderId });

  // Consume the once-per-24h DM throttle before welcomeAdder ever runs.
  assert.equal(db.claimAdderWelcome(chatId, 24), true);

  const ctx = makeCtx({ userId: adderId });
  const ok = await onboarding.welcomeAdder(ctx, chat, { id: adderId, first_name: 'Adder' });

  assert.equal(ok, false, 'the DM itself was skipped, throttled');
  assert.equal(ctx.sent.length, 0);
  assert.equal(subscriptionRows(adderId).length, 0, 'a trial must not start from a join whose DM was skipped');

  // The throttle lifts; a later trigger (any) starts and announces it.
  assert.equal(startTrialForRequest({ from: { id: adderId }, state: { subscription: null } }), true);
  assert.equal(subscriptionRows(adderId).length, 1);
});

test('welcomeAdder does not grant a trial to an adder who never started the bot, even though the DM can still be sent', async () => {
  const chatId = nextChatId();
  const adderId = nextUserId();
  const chat = db.getOrCreateChat({ id: chatId, title: 'Never Started Group', type: 'supergroup' });
  db.getOrCreateUser({ id: adderId, firstName: 'NeverStarted' }); // exists, but no user_started event

  const sent = [];
  const ctx = {
    state: { lang: 'en' },
    botInfo: { username: 'bot', can_read_all_group_messages: true },
    telegram: { sendMessage: async (userId, msg) => { sent.push({ userId, msg }); return { message_id: 1 }; } },
  };
  const ok = await onboarding.welcomeAdder(ctx, chat, { id: adderId, first_name: 'NeverStarted' });

  assert.equal(ok, true, 'the DM itself does not depend on having started the bot');
  assert.equal(subscriptionRows(adderId).length, 0);
  assert.ok(!sent[0].msg.includes('free trial'));
});

test('a trial granted through one trigger is not granted again through another', async () => {
  const userId = nextUserId();
  const chatId = nextChatId();
  db.getOrCreateUser({ id: userId, firstName: 'DoubleTrigger' });
  track(EVENTS.USER_STARTED, { userId });
  db.getOrCreateChat({ id: chatId, title: 'Double Trigger Group', type: 'group' });
  db.linkUserToChat(chatId, userId);
  db.saveMessage({ chatId, messageId: 1, userId, username: 'u', text: 'first trigger' });

  // Trigger #1: a DM summary request.
  const ctx = makeCtx({ userId, chatType: 'private' });
  await buildAndSendSummary(ctx, chatId, 24);
  assert.equal(subscriptionRows(userId).length, 1);

  // Trigger #2: the same person, now adding the bot to a second group.
  const secondChat = nextChatId();
  const chat = db.getOrCreateChat({ id: secondChat, title: 'Second Group', type: 'supergroup' });
  const adderCtx = makeCtx({ userId });
  const trialNoted = await onboarding.welcomeAdder(adderCtx, chat, { id: userId, first_name: 'DoubleTrigger' });
  assert.equal(trialNoted, true, 'the DM still goes out');
  assert.equal(subscriptionRows(userId).length, 1, 'still just the one trial, ever');
  assert.ok(!adderCtx.replies.some((r) => /free trial/.test(r)));
});

// =========================================================================
// Tips: pickTip's rules and the mute callback
// =========================================================================

test('pickTip suggests find after a summary in a group, once', () => {
  const userId = nextUserId();
  db.getOrCreateUser({ id: userId, firstName: 'Tipped' });
  const limits = FREE_LIMITS;

  assert.equal(pickTip(userId, 'summary', { chatId: -1, isChannel: false, limits }), 'find');
});

test('pickTip does not suggest find in a channel, or once find was already used', () => {
  const userId = nextUserId();
  db.getOrCreateUser({ id: userId, firstName: 'Tipped2' });

  assert.equal(pickTip(userId, 'summary', { chatId: -1, isChannel: true, limits: FREE_LIMITS }), null);

  track(EVENTS.FIND_REQUESTED, { userId });
  assert.equal(pickTip(userId, 'summary', { chatId: -1, isChannel: false, limits: FREE_LIMITS }), null);
});

test('pickTip suggests digest once premium keeps coming back to the same chat twice in a week', () => {
  const userId = nextUserId();
  const chatId = nextChatId();
  db.getOrCreateUser({ id: userId, firstName: 'Digester' });
  // Disqualify 'find' with a channel so the digest rule is exercised alone.
  track(EVENTS.SUMMARY_COMPLETED, { userId, chatId });
  track(EVENTS.SUMMARY_COMPLETED, { userId, chatId });

  assert.equal(
    pickTip(userId, 'summary', { chatId, isChannel: true, limits: PREMIUM_LIMITS }),
    'digest'
  );
});

test('pickTip does not suggest digest on the free plan, or once one is already scheduled', () => {
  const userId = nextUserId();
  const chatId = nextChatId();
  db.getOrCreateUser({ id: userId, firstName: 'Digester2' });
  track(EVENTS.SUMMARY_COMPLETED, { userId, chatId });
  track(EVENTS.SUMMARY_COMPLETED, { userId, chatId });

  assert.equal(
    pickTip(userId, 'summary', { chatId, isChannel: true, limits: FREE_LIMITS }),
    null,
    'free cannot have a scheduled digest at all'
  );

  db.getOrCreateChat({ id: chatId, title: 'Digested Chat', type: 'group' });
  db.setScheduledDigest({ chatId, userId, hourUtc: 9 });
  assert.equal(
    pickTip(userId, 'summary', { chatId, isChannel: true, limits: PREMIUM_LIMITS }),
    null,
    'already has a digest for this chat'
  );
});

test('pickTip suggests filter after three summaries with no keywords set', () => {
  const userId = nextUserId();
  const chatId = nextChatId();
  db.getOrCreateUser({ id: userId, firstName: 'Filterer' });
  for (let i = 0; i < 3; i += 1) track(EVENTS.SUMMARY_COMPLETED, { userId, chatId });

  // isChannel disqualifies 'find'; FREE_LIMITS disqualifies 'digest'.
  assert.equal(pickTip(userId, 'summary', { chatId, isChannel: true, limits: FREE_LIMITS }), 'filter');

  db.setUserFilters(userId, { keywords: ['acme'], categories: [] });
  assert.equal(
    pickTip(userId, 'summary', { chatId, isChannel: true, limits: FREE_LIMITS }),
    null,
    'a keyword already set means the tip has done its job'
  );
});

test('pickTip suggests ask after a find, only with question quota and only once', () => {
  const userId = nextUserId();
  db.getOrCreateUser({ id: userId, firstName: 'Asker' });

  assert.equal(pickTip(userId, 'find', { limits: FREE_LIMITS }), null, 'free has no questions to spend');
  assert.equal(pickTip(userId, 'find', { limits: PREMIUM_LIMITS }), 'ask');

  track(EVENTS.ASK_REQUESTED, { userId });
  assert.equal(pickTip(userId, 'find', { limits: PREMIUM_LIMITS }), null, 'already asked once');
});

test('pickTip enforces a 24h cooldown across tips, and each tip only once ever', () => {
  const userId = nextUserId();
  const chatId = nextChatId();
  db.getOrCreateUser({ id: userId, firstName: 'Cooldown' });

  assert.equal(pickTip(userId, 'summary', { chatId, isChannel: false, limits: FREE_LIMITS }), 'find');
  track(EVENTS.TIP_SHOWN, { userId, metadata: { tip: 'find' } });

  // Within the cooldown window, no tip fires at all, even a different one
  // that would otherwise be eligible.
  for (let i = 0; i < 3; i += 1) track(EVENTS.SUMMARY_COMPLETED, { userId, chatId });
  assert.equal(pickTip(userId, 'summary', { chatId, isChannel: true, limits: FREE_LIMITS }), null);

  // The cooldown has passed, but 'find' was already shown once ever.
  backdateEvent(userId, EVENTS.TIP_SHOWN, '-25 hours');
  assert.equal(
    pickTip(userId, 'summary', { chatId, isChannel: false, limits: FREE_LIMITS }),
    'filter',
    'find is retired for good, so the next eligible tip in priority order fires'
  );
});

test('pickTip is silenced once tips are muted', () => {
  const userId = nextUserId();
  db.getOrCreateUser({ id: userId, firstName: 'Muted' });
  db.setTipsMuted(userId, true);

  assert.equal(pickTip(userId, 'summary', { chatId: -1, isChannel: false, limits: FREE_LIMITS }), null);
});

test('maybeShowTip only fires in a private chat, and tracks + replies with the mute button', async () => {
  const userId = nextUserId();
  db.getOrCreateUser({ id: userId, firstName: 'Shown' });

  const groupCtx = makeCtx({ userId, chatType: 'group', subscription: null });
  const inGroup = await maybeShowTip(groupCtx, 'summary', { chatId: -1, isChannel: false });
  assert.equal(inGroup, null);
  assert.equal(groupCtx.replies.length, 0, 'never shown in a group');

  const dmCtx = makeCtx({ userId, chatType: 'private', subscription: null });
  const tip = await maybeShowTip(dmCtx, 'summary', { chatId: -1, isChannel: false });
  assert.equal(tip, 'find');
  assert.equal(dmCtx.replies.length, 1);
  assert.match(dmCtx.replies[0], /find/);
  assert.deepEqual(buttons(dmCtx), [t('en', 'tips.muteButton')]);

  const rows = db.db.prepare(`SELECT metadata FROM events WHERE user_id = ? AND event_type = 'tip_shown'`).all(userId);
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].metadata), { tip: 'find' });
});

test('maybeShowTip is best-effort: a reply failure is swallowed, not thrown, and the tip still counts as shown', async () => {
  const userId = nextUserId();
  db.getOrCreateUser({ id: userId, firstName: 'Flaky' });
  const ctx = makeCtx({ userId, chatType: 'private' });
  ctx.reply = async () => { throw new Error('telegram exploded'); };

  await assert.doesNotReject(() => maybeShowTip(ctx, 'summary', { chatId: -1, isChannel: false }));

  // Recorded before the send is attempted, so two updates racing in from the
  // same person cannot both pass pickTip's checks before either has written
  // anything — the cost of that guarantee is that a failed send still counts.
  const rows = db.db.prepare(`SELECT metadata FROM events WHERE user_id = ? AND event_type = 'tip_shown'`).all(userId);
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].metadata), { tip: 'find' });
});

test('the tips:mute callback mutes the user, tracks it, answers, and removes the keyboard', async () => {
  const userId = nextUserId();
  db.getOrCreateUser({ id: userId, firstName: 'Mutable' });

  const captured = {};
  tipsModule({ action: (name, fn) => { captured[name] = fn; } });

  const ctx = makeCtx({ userId });
  await captured['tips:mute'](ctx);

  assert.equal(db.areTipsMuted(userId), true);
  assert.equal(ctx.cbAnswers.length, 1);
  assert.equal(ctx.editedMarkups.length, 1);
  assert.equal(ctx.editedMarkups[0], undefined);

  const rows = db.db.prepare(`SELECT 1 FROM events WHERE user_id = ? AND event_type = 'tips_muted'`).all(userId);
  assert.equal(rows.length, 1);

  // And it is now silenced for good.
  assert.equal(pickTip(userId, 'summary', { chatId: -1, isChannel: false, limits: FREE_LIMITS }), null);
});

// =========================================================================
// /status: the getting-started checklist
// =========================================================================

function statusCtx(userId, subscription) {
  return { from: { id: userId }, state: { lang: 'en', subscription } };
}

test('the checklist is shown to a free user with nothing connected, digest locked', () => {
  const userId = nextUserId();
  db.getOrCreateUser({ id: userId, firstName: 'FreshFree' });

  const { text } = buildStatus(statusCtx(userId, null));
  assert.match(text, /Getting started/);
  assert.match(text, new RegExp(t('en', 'status.checklistHeader', { done: 0, total: 3 }).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(text, /⬜ Connect a group or a channel/);
  assert.match(text, /⬜ Get your first summary/);
  assert.match(text, /🔒 Get it every morning — \/digest \(premium\)/);
});

test('the checklist ticks off what is done, free user connected but not yet summarized', () => {
  const userId = nextUserId();
  const chatId = nextChatId();
  db.getOrCreateUser({ id: userId, firstName: 'ConnectedFree' });
  db.getOrCreateChat({ id: chatId, title: 'Connected Chat', type: 'group' });
  db.linkUserToChat(chatId, userId);

  const { text } = buildStatus(statusCtx(userId, null));
  assert.match(text, /✅ Connect a group or a channel/);
  assert.match(text, /⬜ Get your first summary/);
});

test('the checklist disappears for a free user once connected and summarized (digest can never apply)', () => {
  const userId = nextUserId();
  const chatId = nextChatId();
  db.getOrCreateUser({ id: userId, firstName: 'DoneFree' });
  db.getOrCreateChat({ id: chatId, title: 'Done Chat', type: 'group' });
  db.linkUserToChat(chatId, userId);
  track(EVENTS.SUMMARY_COMPLETED, { userId, chatId });

  const { text } = buildStatus(statusCtx(userId, null));
  assert.ok(!text.includes('Getting started'), 'nothing left a free plan can do about the digest step');
});

test('the checklist stays for a premium user who has not scheduled a digest yet', () => {
  const userId = nextUserId();
  const chatId = nextChatId();
  db.getOrCreateUser({ id: userId, firstName: 'PremiumNoDigest' });
  db.getOrCreateChat({ id: chatId, title: 'Premium Chat', type: 'group' });
  db.linkUserToChat(chatId, userId);
  track(EVENTS.SUMMARY_COMPLETED, { userId, chatId });

  const { text } = buildStatus(statusCtx(userId, { plan: 'monthly' }));
  assert.match(text, /Getting started/);
  assert.match(text, /⬜ Get it every morning — \/digest/);
  assert.ok(!text.includes('(premium)'), 'a premium user is not told the digest step is locked');
});

test('the checklist disappears for a premium user once a digest is scheduled', () => {
  const userId = nextUserId();
  const chatId = nextChatId();
  db.getOrCreateUser({ id: userId, firstName: 'PremiumDigest' });
  db.getOrCreateChat({ id: chatId, title: 'Premium Digest Chat', type: 'group' });
  db.linkUserToChat(chatId, userId);
  track(EVENTS.SUMMARY_COMPLETED, { userId, chatId });
  db.setScheduledDigest({ chatId, userId, hourUtc: 8 });

  const { text } = buildStatus(statusCtx(userId, { plan: 'monthly' }));
  assert.ok(!text.includes('Getting started'));
});

// =========================================================================
// Scheduler: runGroupReadyPings
// =========================================================================

function seedReadyGroup({ chatId, adderId, messageCount, createdAgo = null, started = true }) {
  db.getOrCreateUser({ id: adderId, firstName: 'Adder' });
  if (started) track(EVENTS.USER_STARTED, { userId: adderId });
  db.getOrCreateChat({ id: chatId, title: `Ready Group ${chatId}`, type: 'supergroup', addedBy: adderId });
  db.linkUserToChat(chatId, adderId);
  if (createdAgo) {
    db.db.prepare(`UPDATE chats SET created_at = datetime('now', ?) WHERE id = ?`).run(createdAgo, chatId);
  }
  for (let i = 0; i < messageCount; i += 1) {
    db.saveMessage({ chatId, messageId: i + 1, userId: adderId, username: 'u', text: `message ${i}` });
  }
}

function readyPingedAt(chatId) {
  return db.db.prepare('SELECT ready_pinged_at FROM chats WHERE id = ?').get(chatId).ready_pinged_at;
}

function eventCountFor(type, userId, chatId) {
  // `chat_id = NULL` never matches in SQL, so a NULL chatId (the onboarding
  // nudge events, which carry none) needs its own clause.
  if (chatId === null || chatId === undefined) {
    return db.db
      .prepare('SELECT COUNT(*) c FROM events WHERE event_type = ? AND user_id = ? AND chat_id IS NULL')
      .get(type, userId).c;
  }
  return db.db
    .prepare('SELECT COUNT(*) c FROM events WHERE event_type = ? AND user_id = ? AND chat_id = ?')
    .get(type, userId, chatId).c;
}

// Collects the waits instead of taking them, so a retry test can assert the
// scheduler waited without the suite actually sleeping for it — see
// test/scheduler.test.js.
function recordingSleep() {
  const waits = [];
  return { waits, sleep: async (ms) => { waits.push(ms); } };
}

test('runGroupReadyPings DMs the adder once a fresh group has enough messages', async () => {
  const chatId = nextChatId();
  const adderId = nextUserId();
  seedReadyGroup({ chatId, adderId, messageCount: READY_MESSAGES });

  await runGroupReadyPings();

  const sent = sentMessages.find((m) => m.chatId === adderId);
  assert.ok(sent, 'the adder was DMed');
  assert.match(sent.text, /Ready Group/);
  assert.equal(
    sent.extra.reply_markup.inline_keyboard[0][0].callback_data,
    `summary:chat:${chatId}:auto`
  );
  assert.ok(readyPingedAt(chatId), 'marked done so it is not sent again');
  assert.equal(eventCountFor(EVENTS.GROUP_READY_SENT, adderId, chatId), 1);
});

test('runGroupReadyPings leaves a quiet, brand-new group pending', async () => {
  const chatId = nextChatId();
  const adderId = nextUserId();
  seedReadyGroup({ chatId, adderId, messageCount: READY_MESSAGES_AFTER_A_DAY - 1 });

  await runGroupReadyPings();

  assert.ok(!sentMessages.some((m) => m.chatId === adderId));
  assert.equal(readyPingedAt(chatId), null, 'still awaiting, might reach the threshold later');
});

test('runGroupReadyPings uses the lower threshold once a group is a day old', async () => {
  const chatId = nextChatId();
  const adderId = nextUserId();
  seedReadyGroup({
    chatId,
    adderId,
    messageCount: READY_MESSAGES_AFTER_A_DAY,
    createdAgo: '-2 days',
  });

  await runGroupReadyPings();

  assert.ok(sentMessages.some((m) => m.chatId === adderId));
  assert.ok(readyPingedAt(chatId));
});

test('runGroupReadyPings marks a group done without sending when the adder is no longer linked', async () => {
  const chatId = nextChatId();
  const adderId = nextUserId();
  seedReadyGroup({ chatId, adderId, messageCount: READY_MESSAGES });
  db.db.prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?').run(chatId, adderId);

  await runGroupReadyPings();

  assert.ok(!sentMessages.some((m) => m.chatId === adderId), 'the adder left, so nobody was DMed');
  assert.ok(readyPingedAt(chatId));
  assert.equal(eventCountFor(EVENTS.GROUP_READY_SENT, adderId, chatId), 0);
});

test('runGroupReadyPings marks a group done without sending once the adder already has a summary of it', async () => {
  const chatId = nextChatId();
  const adderId = nextUserId();
  seedReadyGroup({ chatId, adderId, messageCount: READY_MESSAGES });
  db.recordSummaryRead(adderId, chatId);

  await runGroupReadyPings();

  assert.ok(!sentMessages.some((m) => m.chatId === adderId), 'they already know; no need to be told');
  assert.ok(readyPingedAt(chatId));
});

test('runGroupReadyPings stays pending for an adder who never started the bot, and cannot be reached', async () => {
  const chatId = nextChatId();
  const adderId = nextUserId();
  seedReadyGroup({ chatId, adderId, messageCount: READY_MESSAGES, started: false });

  await runGroupReadyPings();

  assert.ok(!sentMessages.some((m) => m.chatId === adderId));
  assert.equal(readyPingedAt(chatId), null, 'kept pending in case they /start within the week');
});

test('runGroupReadyPings marks a blocked adder done without retrying forever', async () => {
  const chatId = nextChatId();
  const adderId = nextUserId();
  seedReadyGroup({ chatId, adderId, messageCount: READY_MESSAGES });
  scriptSends(adderId, [telegramError(403, 'Forbidden: bot was blocked by the user')]);

  await runGroupReadyPings();

  assert.ok(readyPingedAt(chatId));
  assert.equal(eventCountFor(EVENTS.GROUP_READY_SENT, adderId, chatId), 0, 'never sent, so never tracked as sent');
});

test('runGroupReadyPings leaves a group pending after a non-blocked send failure, to retry next tick', async () => {
  const chatId = nextChatId();
  const adderId = nextUserId();
  seedReadyGroup({ chatId, adderId, messageCount: READY_MESSAGES });
  // The sender retries transient failures up to MAX_ATTEMPTS (3) before
  // giving up — queue enough failures to exhaust every attempt.
  scriptSends(adderId, [new Error('socket hang up'), new Error('socket hang up'), new Error('socket hang up')]);

  const { sleep } = recordingSleep();
  await runGroupReadyPings({ sleep });

  assert.equal(readyPingedAt(chatId), null);
});

test('runGroupReadyPings never considers a group older than 7 days', async () => {
  const chatId = nextChatId();
  const adderId = nextUserId();
  seedReadyGroup({ chatId, adderId, messageCount: READY_MESSAGES, createdAgo: '-8 days' });

  await runGroupReadyPings();

  assert.ok(!sentMessages.some((m) => m.chatId === adderId));
  assert.equal(readyPingedAt(chatId), null, 'excluded from the query outright, not merely unsent');
});

// =========================================================================
// Scheduler: runOnboardingNudges
// =========================================================================

function seedNudgeCandidate(userId, { startedAgo = '-2 days', qualifyingEvent = EVENTS.ONBOARDING_PATH_CHOSEN } = {}) {
  db.getOrCreateUser({ id: userId, firstName: 'Nudgeable' });
  track(EVENTS.USER_STARTED, { userId });
  backdateEvent(userId, EVENTS.USER_STARTED, startedAgo);
  if (qualifyingEvent) track(qualifyingEvent, { userId });
}

test('runOnboardingNudges DMs someone one to three days after /start who did something but connected nothing', async () => {
  const userId = nextUserId();
  seedNudgeCandidate(userId);

  await runOnboardingNudges();

  const sent = sentMessages.find((m) => m.chatId === userId);
  assert.ok(sent);
  assert.match(sent.text, /Still want a hand/);
  assert.ok(sent.extra.reply_markup.inline_keyboard.length > 0, 'the path keyboard is attached');
  assert.equal(eventCountFor(EVENTS.ONBOARDING_NUDGE_SENT, userId, null), 1);
});

test('runOnboardingNudges skips someone still inside their first day', async () => {
  const userId = nextUserId();
  seedNudgeCandidate(userId, { startedAgo: '-12 hours' });

  await runOnboardingNudges();

  assert.ok(!sentMessages.some((m) => m.chatId === userId));
});

test('runOnboardingNudges skips someone whose first /start was more than three days ago', async () => {
  const userId = nextUserId();
  seedNudgeCandidate(userId, { startedAgo: '-5 days' });

  await runOnboardingNudges();

  assert.ok(!sentMessages.some((m) => m.chatId === userId));
});

test('runOnboardingNudges skips someone who already connected a chat', async () => {
  const userId = nextUserId();
  const chatId = nextChatId();
  seedNudgeCandidate(userId);
  db.getOrCreateChat({ id: chatId, title: 'Any Chat', type: 'group' });
  db.linkUserToChat(chatId, userId);

  await runOnboardingNudges();

  assert.ok(!sentMessages.some((m) => m.chatId === userId));
});

test('runOnboardingNudges never repeats itself', async () => {
  const userId = nextUserId();
  seedNudgeCandidate(userId);
  track(EVENTS.ONBOARDING_NUDGE_SENT, { userId });

  await runOnboardingNudges();

  assert.ok(!sentMessages.some((m) => m.chatId === userId));
});

test('runOnboardingNudges requires some sign of interest beyond the bare /start events', async () => {
  const userId = nextUserId();
  db.getOrCreateUser({ id: userId, firstName: 'JustStarted' });
  track(EVENTS.USER_STARTED, { userId });
  backdateEvent(userId, EVENTS.USER_STARTED, '-2 days');
  // Only events user_started/trial_started/referral_started ever get recorded — none count.
  track(EVENTS.TRIAL_STARTED, { userId });
  track(EVENTS.REFERRAL_STARTED, { userId });

  await runOnboardingNudges();

  assert.ok(!sentMessages.some((m) => m.chatId === userId), 'pressing /start and doing nothing else does not earn a nudge');
});

test('runOnboardingNudges records a blocked send so the person is never retried', async () => {
  const userId = nextUserId();
  seedNudgeCandidate(userId);
  scriptSends(userId, [telegramError(403, 'Forbidden: bot was blocked by the user')]);

  await runOnboardingNudges();

  const rows = db.db
    .prepare(`SELECT metadata FROM events WHERE user_id = ? AND event_type = 'onboarding_nudge_sent'`)
    .all(userId);
  assert.equal(rows.length, 1);
  assert.deepEqual(JSON.parse(rows[0].metadata), { blocked: true });

  // And the query no longer offers them up.
  assert.ok(!db.getUsersDueOnboardingNudge().includes(userId));
});

test('runOnboardingNudges leaves a non-blocked failure untracked, to retry next tick', async () => {
  const userId = nextUserId();
  seedNudgeCandidate(userId);
  scriptSends(userId, [new Error('socket hang up'), new Error('socket hang up'), new Error('socket hang up')]);

  const { sleep } = recordingSleep();
  await runOnboardingNudges({ sleep });

  const rows = db.db.prepare(`SELECT 1 FROM events WHERE user_id = ? AND event_type = 'onboarding_nudge_sent'`).all(userId);
  assert.equal(rows.length, 0);
  assert.ok(db.getUsersDueOnboardingNudge().includes(userId));
});

// =========================================================================
// Markdown balance of the new copy, en + ru
// =========================================================================

test('the new onboarding and tips copy is balanced Markdown in every language', () => {
  const cases = [
    ['onboarding.groupReady', { title: 'A Group' }],
    ['onboarding.nudge', {}],
    ['tips.find', {}],
    ['tips.digest', {}],
    ['tips.filter', {}],
    ['tips.ask', {}],
    ['tips.muteButton', {}],
    ['tips.muted', {}],
    ['status.checklistHeader', { done: 1, total: 3 }],
    ['status.checklistConnect', {}],
    ['status.checklistSummary', {}],
    ['status.checklistDigest', {}],
    ['status.checklistDigestLocked', {}],
  ];

  for (const lang of SUPPORTED_LANGUAGES) {
    for (const [key, params] of cases) {
      const text = t(lang, key, params);
      assert.notEqual(text, key, `no ${lang} copy for ${key}`);
      assert.ok(!text.includes('{'), `${lang} ${key} has an unfilled placeholder`);

      for (const [name, char] of [['bold', '*'], ['code', '`'], ['italic', '_']]) {
        const count = text.split(char).length - 1;
        assert.equal(count % 2, 0, `unbalanced ${name} marker (${char}) in ${lang} ${key}`);
      }
    }
  }
});
