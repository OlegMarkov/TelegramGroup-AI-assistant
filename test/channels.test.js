const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-channels-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

// Patched before the commands are loaded, so their destructured imports pick
// up the stubs. Nothing in this file touches the network.
const channelSource = require('../src/services/channelSource');
const resolveCalls = [];
channelSource.resolveChannel = async (handle) => {
  resolveCalls.push(handle);
  return { handle: String(handle).toLowerCase(), title: `Title of ${handle}` };
};
// The failure case is selected by handle rather than by swapping this stub
// later: digest.js destructures fetchChannelPosts at load, so a reassignment
// after that point would silently have no effect.
const FAILING_HANDLE = 'failchan';

channelSource.fetchChannelPosts = async (handle) => {
  if (handle === FAILING_HANDLE) throw new Error('upstream exploded');
  return {
    title: 'Stub Channel',
    posts: [
      { id: 1, text: 'Первый пост про нейросети', createdAt: new Date().toISOString() },
      { id: 2, text: 'Second post about funding', createdAt: new Date().toISOString() },
    ],
  };
};

const deepseek = require('../src/services/deepseek');
deepseek.summarize = async () => 'stub summary';

const db = require('../src/services/database');
const registerChannel = require('../src/commands/channel');
const registerSummary = require('../src/commands/summary');

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
registerChannel(fakeBot);
registerSummary(fakeBot);

const PREMIUM = { plan: 'monthly', status: 'active' };

function makeCtx({ from, subscription, text, chatType }) {
  const replies = [];
  const edits = [];
  const chatActions = [];
  // Every keyboard the handler drew, in order, so a test can assert on what
  // the user is actually looking at rather than only on the body text.
  const markups = [];
  const record = (msg, extra) => {
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
    chatActions,
    reply: async (msg, extra) => {
      replies.push(msg);
      record(msg, extra);
      return { message_id: 1 };
    },
    editMessageText: async (msg, extra) => {
      edits.push(msg);
      record(msg, extra);
      return { message_id: 1 };
    },
    sendChatAction: async (action) => {
      chatActions.push(action);
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

function callbackData(ctx, matcher) {
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

/** A plain message in DM, as it reaches the pending-add capture. */
async function sendText(text, opts) {
  const ctx = makeCtx({ ...opts, text });
  ctx.passedThrough = false;
  await handlers.text(ctx, async () => {
    ctx.passedThrough = true;
  });
  return ctx;
}

test.after(() => {
  db.db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

test('channel ids are allocated from a range real Telegram chat ids can never reach', () => {
  // A synthetic id colliding with a real chat id would serve one chat's
  // content to another chat's members. Telegram gives groups and channels
  // negative ids; ours are positive and above a high base, so the two spaces
  // cannot overlap by construction.
  const a = db.getOrCreateChannel({ username: 'alpha_news', title: 'Alpha' });
  const b = db.getOrCreateChannel({ username: 'beta_news', title: 'Beta' });

  assert.ok(a.id >= db.CHANNEL_ID_BASE, 'below the reserved base');
  assert.ok(b.id > a.id, 'ids are distinct and monotonic');

  db.getOrCreateChat({ id: -1001234567890, title: 'A real supergroup', type: 'supergroup' });
  const rows = db.db.prepare('SELECT id, source FROM chats').all();
  for (const row of rows) {
    if (row.source === 'channel') assert.ok(row.id > 0, 'channels must be positive');
    else assert.ok(row.id < 0, 'bot-sourced chats are real Telegram ids, which are negative');
  }
});

test('the same channel is one row however it is spelled', () => {
  const first = db.getOrCreateChannel({ username: 'shared_chan', title: 'Shared' });
  const again = db.getOrCreateChannel({ username: 'Shared_Chan'.toLowerCase(), title: 'Shared Renamed' });

  assert.equal(again.id, first.id, 'two users following one channel share a row');
  assert.equal(again.title, 'Shared Renamed', 'the title is refreshed');
  assert.equal(db.db.prepare(`SELECT COUNT(*) c FROM chats WHERE username = 'shared_chan'`).get().c, 1);
});

test('a channel does not consume the free plan group quota', () => {
  // Free users get one group. A channel occupying that slot would charge them
  // twice for one feature — and channels are gated by subscription anyway.
  const user = { id: 700, first_name: 'Quota' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });

  const group = db.getOrCreateChat({ id: -500700, title: 'Their group', type: 'supergroup' });
  const channel = db.getOrCreateChannel({ username: 'quota_chan', title: 'Quota Chan' });
  db.linkUserToChat(channel.id, user.id); // linked first, so it would take the slot
  db.linkUserToChat(group.id, user.id);

  assert.equal(db.isChatWithinFreeLimit(user.id, group.id, 1), true, 'the group still fits in the free slot');

  const allowed = db.getAllowedUserChats(user.id, 1);
  assert.deepEqual(allowed.map((c) => c.id), [group.id], 'channels never appear in the group list');
  assert.equal(db.getUserChannels(user.id).length, 1);
  assert.equal(db.getUserGroups(user.id).length, 1);
});

test('the free plan includes one channel, and the second is an upsell', async () => {
  // Free is one rather than zero so the feature is something people use and
  // outgrow, instead of something they only meet as a paywall.
  const user = { id: 701, first_name: 'Free' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });

  const first = await run('addchannel', { from: user, text: '/addchannel @freechannel' });
  assert.ok(first.replies.some((r) => /Added/.test(r)), 'the first channel is allowed without paying');
  assert.equal(db.getUserChannels(user.id).length, 1);

  const second = await run('addchannel', { from: user, text: '/addchannel @secondchannel' });
  assert.match(second.replies[second.replies.length - 1], /free plan includes/i);
  assert.equal(db.getUserChannels(user.id).length, 1, 'the second was not added');
  assert.equal(db.getChannelByUsername('secondchannel'), undefined, 'and no channel row was created');
});

test('a premium user at the ceiling is told to remove one, not to subscribe', async () => {
  // Same condition, entirely different message: hitting the free allowance is
  // an upsell, hitting the premium ceiling is housekeeping.
  const user = { id: 712, first_name: 'AtCeiling' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });

  const { PREMIUM_LIMITS } = require('../src/models/subscription');
  for (let i = 0; i < PREMIUM_LIMITS.maxChannels; i += 1) {
    const c = db.getOrCreateChannel({ username: `ceiling_${i}`, title: `C ${i}` });
    db.linkUserToChat(c.id, user.id);
  }

  const ctx = await run('addchannel', { from: user, subscription: PREMIUM, text: '/addchannel @onemore2' });
  const last = ctx.replies[ctx.replies.length - 1];
  assert.match(last, /maximum/i);
  assert.ok(!/subscribe/i.test(last), 'a paying user must not be asked to subscribe');
});

test('an invalid handle is rejected before any network request is made', async () => {
  // Ordering matters: validating after the fetch would still let a caller
  // steer a server-side request with the raw string.
  const user = { id: 702, first_name: 'Premium' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });
  const before = resolveCalls.length;

  const ctx = await run('addchannel', {
    from: user,
    subscription: PREMIUM,
    text: '/addchannel http://169.254.169.254/latest/meta-data',
  });

  assert.match(ctx.replies[0], /doesn't look like a channel/i);
  assert.equal(resolveCalls.length, before, 'no lookup was attempted');
});

test('a premium user can add, list and remove a channel', async () => {
  const user = { id: 703, first_name: 'Sub' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });

  const added = await run('addchannel', { from: user, subscription: PREMIUM, text: '/addchannel @Durov' });
  assert.ok(added.replies.some((r) => /Added/.test(r)));
  assert.equal(db.getUserChannels(user.id).length, 1);
  assert.equal(db.getUserChannels(user.id)[0].username, 'durov', 'stored lowercased');

  const listed = await run('channels', { from: user, subscription: PREMIUM, text: '/channels' });
  assert.match(listed.replies[0], /@durov/);

  const dupe = await run('addchannel', { from: user, subscription: PREMIUM, text: '/addchannel @durov' });
  assert.match(dupe.replies[0], /already following/i);
  assert.equal(db.getUserChannels(user.id).length, 1);

  const removed = await run('removechannel', { from: user, subscription: PREMIUM, text: '/removechannel @durov' });
  assert.match(removed.replies[0], /Removed/);
  assert.equal(db.getUserChannels(user.id).length, 0);
});

test('removing a channel only ever unlinks the caller', async () => {
  const owner = { id: 704, first_name: 'Owner' };
  const other = { id: 705, first_name: 'Other' };
  db.getOrCreateUser({ id: owner.id, firstName: owner.first_name });
  db.getOrCreateUser({ id: other.id, firstName: other.first_name });

  const chan = db.getOrCreateChannel({ username: 'sharedremoval', title: 'Shared' });
  db.linkUserToChat(chan.id, owner.id);
  db.linkUserToChat(chan.id, other.id);

  await run('removechannel', { from: other, subscription: PREMIUM, text: '/removechannel @sharedremoval' });

  assert.equal(db.getUserChannels(other.id).length, 0);
  assert.equal(db.getUserChannels(owner.id).length, 1, "another user's subscription is untouched");
});

test('the per-user channel cap is enforced', async () => {
  const user = { id: 706, first_name: 'Hoarder' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });

  const { PREMIUM_LIMITS } = require('../src/models/subscription');
  for (let i = 0; i < PREMIUM_LIMITS.maxChannels; i += 1) {
    const c = db.getOrCreateChannel({ username: `capchan_${i}`, title: `Cap ${i}` });
    db.linkUserToChat(c.id, user.id);
  }

  const ctx = await run('addchannel', { from: user, subscription: PREMIUM, text: '/addchannel @onemore' });
  assert.match(ctx.replies[0], /maximum/i);
  assert.equal(db.getUserChannels(user.id).length, PREMIUM_LIMITS.maxChannels);
});

test('a lapsed subscriber keeps their first channel and loses the rest', async () => {
  // callback_data comes from the client. Hiding channels from the picker is
  // presentation; this is the check that holds when a subscription expires and
  // the user taps a button Telegram still shows them. Losing the oldest
  // channel instead of the newest would be the more surprising behaviour.
  const user = { id: 707, first_name: 'Lapsed' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });
  const first = db.getOrCreateChannel({ username: 'lapsedfirst', title: 'First' });
  const second = db.getOrCreateChannel({ username: 'lapsedsecond', title: 'Second' });
  db.linkUserToChat(first.id, user.id);
  db.linkUserToChat(second.id, user.id);

  const kept = await fireCallback(`summary:chat:${first.id}:24`, { from: user, subscription: null });
  assert.ok(
    kept.replies.some((r) => typeof r === 'string' && r.includes('stub summary')),
    'their earliest channel still works on the free plan'
  );

  const lost = await fireCallback(`summary:chat:${second.id}:24`, { from: user, subscription: null });
  assert.ok(lost.replies.some((r) => typeof r === 'string' && /free plan/i.test(r)));
  assert.ok(!lost.replies.some((r) => typeof r === 'string' && r.includes('stub summary')));

  const resubscribed = await fireCallback(`summary:chat:${second.id}:24`, { from: user, subscription: PREMIUM });
  assert.ok(resubscribed.replies.some((r) => typeof r === 'string' && r.includes('stub summary')));
});

test('the picker offers only the channels the plan allows', async () => {
  const user = { id: 713, first_name: 'Picker' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });
  for (const name of ['pick_a', 'pick_b', 'pick_c']) {
    db.linkUserToChat(db.getOrCreateChannel({ username: name, title: name }).id, user.id);
  }

  assert.equal(db.getAllowedUserChannels(user.id, 1).length, 1, 'free sees one');
  assert.equal(db.getAllowedUserChannels(user.id, 20).length, 3, 'premium sees all');
  assert.equal(db.getUserChannels(user.id).length, 3, 'but none are deleted');

  // /channels still lists everything, with a note about what is locked.
  const ctx = await run('channels', { from: user, text: '/channels' });
  assert.match(ctx.replies[0], /pick_a/);
  assert.match(ctx.replies[0], /free plan/i, 'the locked ones are explained');
});

test('the list is tappable: one button per channel, plus Add', async () => {
  const user = { id: 720, first_name: 'Tapper' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });
  for (const name of ['tap_one', 'tap_two']) {
    db.linkUserToChat(db.getOrCreateChannel({ username: name, title: name }).id, user.id);
  }

  const ctx = await run('channels', { from: user, subscription: PREMIUM, text: '/channels' });
  const labels = buttons(ctx);

  assert.ok(labels.some((l) => l.includes('tap_one')), 'the first channel is tappable');
  assert.ok(labels.some((l) => l.includes('tap_two')), 'so is the second');
  assert.ok(labels.some((l) => /Add channel/i.test(l)), 'and adding is one tap away');
  assert.ok(!labels.some((l) => /Remove/i.test(l)), 'Remove stays hidden until something is selected');
});

test('selecting channels and pressing Remove unfollows exactly those', async () => {
  const user = { id: 721, first_name: 'Selector' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });
  const ids = {};
  for (const name of ['sel_a', 'sel_b', 'sel_c']) {
    ids[name] = db.getOrCreateChannel({ username: name, title: name }).id;
    db.linkUserToChat(ids[name], user.id);
  }

  await fireCallback(`channel:toggle:${ids.sel_a}`, { from: user, subscription: PREMIUM });
  const afterSecond = await fireCallback(`channel:toggle:${ids.sel_c}`, { from: user, subscription: PREMIUM });

  const labels = buttons(afterSecond);
  assert.ok(labels.some((l) => /Remove \(2\)/.test(l)), 'the button counts what is selected');
  assert.equal(labels.filter((l) => l.startsWith('☑️')).length, 2, 'and both are marked');

  const removed = await fireCallback('channel:remove', { from: user, subscription: PREMIUM });
  assert.ok(removed.replies.some((r) => /sel_a/.test(r) && /sel_c/.test(r)), 'both are named back');

  const left = db.getUserChannels(user.id).map((c) => c.username);
  assert.deepEqual(left, ['sel_b'], 'and only the unselected one survives');
});

test('a second tap deselects, so Remove cannot fire on a stale selection', async () => {
  const user = { id: 722, first_name: 'Undecided' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });
  const id = db.getOrCreateChannel({ username: 'undecided_chan', title: 'Undecided' }).id;
  db.linkUserToChat(id, user.id);

  await fireCallback(`channel:toggle:${id}`, { from: user, subscription: PREMIUM });
  await fireCallback(`channel:toggle:${id}`, { from: user, subscription: PREMIUM });

  const ctx = await fireCallback('channel:remove', { from: user, subscription: PREMIUM });
  assert.ok(ctx.replies.some((r) => /Tap a channel/i.test(r)), 'it asks for a selection');
  assert.equal(db.getUserChannels(user.id).length, 1, 'and removes nothing');
});

test('Remove only ever touches the caller, even for a channel someone else follows', async () => {
  const owner = { id: 723, first_name: 'Owner' };
  const other = { id: 724, first_name: 'Other' };
  db.getOrCreateUser({ id: owner.id, firstName: owner.first_name });
  db.getOrCreateUser({ id: other.id, firstName: other.first_name });
  const id = db.getOrCreateChannel({ username: 'button_shared', title: 'Shared' }).id;
  db.linkUserToChat(id, owner.id);
  db.linkUserToChat(id, other.id);

  await fireCallback(`channel:toggle:${id}`, { from: other, subscription: PREMIUM });
  await fireCallback('channel:remove', { from: other, subscription: PREMIUM });

  assert.equal(db.getUserChannels(other.id).length, 0);
  assert.equal(db.getUserChannels(owner.id).length, 1, "another user's list is untouched");
});

test('selecting a channel that is already gone re-draws the list instead of failing', async () => {
  // callback_data comes from the client, so a keyboard drawn before a removal
  // on another device still offers rows that no longer exist.
  const user = { id: 725, first_name: 'Stale' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });
  const id = db.getOrCreateChannel({ username: 'stale_chan', title: 'Stale' }).id;

  const ctx = await fireCallback(`channel:toggle:${id}`, { from: user, subscription: PREMIUM });
  assert.ok(ctx.replies.some((r) => /not following that channel/i.test(r)));
  assert.equal(ctx.edits.length, 1, 'the list is refreshed to what is actually there');
});

test('Add takes the next message as the channel — a bare name, an @name or a link', async () => {
  for (const [id, input, expected] of [
    [730, 'barename_chan', 'barename_chan'],
    [731, '@athandle_chan', 'athandle_chan'],
    [732, 'https://t.me/linked_chan', 'linked_chan'],
  ]) {
    const user = { id, first_name: 'Adder' };
    db.getOrCreateUser({ id: user.id, firstName: user.first_name });

    await fireCallback('channel:add', { from: user, subscription: PREMIUM });
    const ctx = await sendText(input, { from: user, subscription: PREMIUM });

    assert.equal(ctx.passedThrough, false, 'the answer was consumed, not passed on');
    assert.deepEqual(
      db.getUserChannels(user.id).map((c) => c.username),
      [expected],
      `${input} should follow @${expected}`
    );
    assert.ok(buttons(ctx).some((l) => /Add channel/i.test(l)), 'the refreshed list comes back with it');
  }
});

test('a typo at the Add prompt keeps the prompt open', async () => {
  const user = { id: 733, first_name: 'Typo' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });

  await fireCallback('channel:add', { from: user, subscription: PREMIUM });

  const typo = await sendText('h', { from: user, subscription: PREMIUM });
  assert.match(typo.replies[0], /doesn't look like a channel/i);
  assert.equal(db.getUserChannels(user.id).length, 0);

  // Still waiting: retyping is enough, no second trip through the button.
  const retry = await sendText('@retry_chan', { from: user, subscription: PREMIUM });
  assert.equal(retry.passedThrough, false);
  assert.deepEqual(db.getUserChannels(user.id).map((c) => c.username), ['retry_chan']);
});

test('the Add prompt captures one message, and only that one', async () => {
  const user = { id: 734, first_name: 'Once' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });

  await fireCallback('channel:add', { from: user, subscription: PREMIUM });
  await sendText('@once_chan', { from: user, subscription: PREMIUM });

  const after = await sendText('just chatting', { from: user, subscription: PREMIUM });
  assert.equal(after.passedThrough, true, 'the next message is an ordinary message again');
  assert.equal(db.getUserChannels(user.id).length, 1);
});

test('commands and menu buttons are never swallowed by a pending Add', async () => {
  // This handler sits ahead of the ones registered by later command modules,
  // so anything that is really a menu tap has to keep flowing — otherwise
  // tapping ⭐ Subscribe at the prompt would try to follow a channel by that name.
  const user = { id: 735, first_name: 'Escapee' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });

  await fireCallback('channel:add', { from: user, subscription: PREMIUM });
  const menuTap = await sendText('⭐ Subscribe', { from: user, subscription: PREMIUM });
  assert.equal(menuTap.passedThrough, true);

  const command = await sendText('/summary', { from: user, subscription: PREMIUM });
  assert.equal(command.passedThrough, true);
  assert.equal(db.getUserChannels(user.id).length, 0, 'nothing was added along the way');
});

test('nothing is captured in a group, where the next message is somebody talking', async () => {
  const user = { id: 736, first_name: 'Grouped' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });

  const tapped = await fireCallback('channel:add', {
    from: user,
    subscription: PREMIUM,
    chatType: 'supergroup',
  });
  assert.ok(tapped.replies.some((r) => /addchannel/.test(r)), 'it points at the command instead');

  const chatter = await sendText('anything at all', {
    from: user,
    subscription: PREMIUM,
    chatType: 'supergroup',
  });
  assert.equal(chatter.passedThrough, true);
  assert.equal(db.getUserChannels(user.id).length, 0);
});

test('Add says no at the cap instead of asking for a name it will refuse', async () => {
  const user = { id: 737, first_name: 'Capped' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });
  db.linkUserToChat(db.getOrCreateChannel({ username: 'capped_first', title: 'First' }).id, user.id);

  const ctx = await fireCallback('channel:add', { from: user, subscription: null });
  assert.match(ctx.replies.join('\n'), /free plan includes/i);

  // And the prompt was never armed, so the next message stays an ordinary one.
  const after = await sendText('@sneaky_chan', { from: user, subscription: null });
  assert.equal(after.passedThrough, true);
  assert.equal(db.getUserChannels(user.id).length, 1);
});

test('a bare /addchannel in a DM asks for the name instead of reciting the syntax', async () => {
  const user = { id: 738, first_name: 'Bare' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });

  const ctx = await run('addchannel', { from: user, subscription: PREMIUM, text: '/addchannel' });
  assert.match(ctx.replies[0], /Send me the channel/i);

  const answered = await sendText('@bare_chan', { from: user, subscription: PREMIUM });
  assert.equal(answered.passedThrough, false);
  assert.deepEqual(db.getUserChannels(user.id).map((c) => c.username), ['bare_chan']);
});

test('cancelling the Add prompt leaves the next message alone', async () => {
  const user = { id: 739, first_name: 'Canceller' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });

  await fireCallback('channel:add', { from: user, subscription: PREMIUM });
  const cancelled = await fireCallback('channel:addcancel', { from: user, subscription: PREMIUM });
  assert.match(cancelled.edits[0], /Cancelled/i);

  const after = await sendText('@ignored_chan', { from: user, subscription: PREMIUM });
  assert.equal(after.passedThrough, true);
  assert.equal(db.getUserChannels(user.id).length, 0);
});

test('a bare /removechannel opens the list rather than teaching a syntax', async () => {
  const user = { id: 740, first_name: 'Lazy' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });
  db.linkUserToChat(db.getOrCreateChannel({ username: 'lazy_chan', title: 'Lazy Chan' }).id, user.id);

  const ctx = await run('removechannel', { from: user, subscription: PREMIUM, text: '/removechannel' });
  assert.ok(callbackData(ctx, /Lazy Chan/), 'the channel is there to tap');
  assert.equal(db.getUserChannels(user.id).length, 1, 'and nothing was removed by opening it');
});

test('channels locked by the plan are marked, and can still be removed', async () => {
  // The way out of "you follow more than your plan allows" is removing one, so
  // the locked rows have to stay tappable.
  const user = { id: 741, first_name: 'Lapsed' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });
  const ids = ['lock_one', 'lock_two'].map((name) => {
    const id = db.getOrCreateChannel({ username: name, title: name }).id;
    db.linkUserToChat(id, user.id);
    return id;
  });

  const ctx = await run('channels', { from: user, subscription: null, text: '/channels' });
  const locked = buttons(ctx).filter((l) => l.includes('🔒'));
  assert.equal(locked.length, 1, 'exactly the one past the free allowance is marked');
  assert.ok(locked[0].includes('lock_two'));

  await fireCallback(`channel:toggle:${ids[1]}`, { from: user, subscription: null });
  await fireCallback('channel:remove', { from: user, subscription: null });
  assert.deepEqual(db.getUserChannels(user.id).map((c) => c.username), ['lock_one']);
});

test('channel posts are summarized from the live fetch, not from stored messages', async () => {
  // Nothing writes channel posts to the messages table; if that ever changed,
  // third-party content would start landing in backups.
  const user = { id: 708, first_name: 'Reader' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });
  const chan = db.getOrCreateChannel({ username: 'livechan', title: 'Live Chan' });
  db.linkUserToChat(chan.id, user.id);

  await fireCallback(`summary:chat:${chan.id}:24`, { from: user, subscription: PREMIUM });

  const stored = db.db.prepare('SELECT COUNT(*) c FROM messages WHERE chat_id = ?').get(chan.id).c;
  assert.equal(stored, 0, 'channel posts must not be persisted');
});

test('a summary shows the typing indicator while it is being written', async () => {
  // Generation takes ~25 seconds against the real API, during which the chat
  // is otherwise silent and looks stuck.
  const user = { id: 710, first_name: 'Waiting' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });
  const chan = db.getOrCreateChannel({ username: 'typingchan', title: 'Typing Chan' });
  db.linkUserToChat(chan.id, user.id);

  const ctx = await fireCallback(`summary:chat:${chan.id}:24`, { from: user, subscription: PREMIUM });
  assert.ok(ctx.chatActions.includes('typing'), 'the indicator was never shown');
});

test('a failed summary still clears the typing indicator', async () => {
  // The indicator is stopped in a `finally`. Without it a failed digest leaves
  // the timer refreshing "typing…" forever against a chat with no answer coming.
  const user = { id: 711, first_name: 'Failing' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });
  const chan = db.getOrCreateChannel({ username: FAILING_HANDLE, title: 'Fail Chan' });
  db.linkUserToChat(chan.id, user.id);

  const ctx = await fireCallback(`summary:chat:${chan.id}:24`, { from: user, subscription: PREMIUM });

  assert.ok(ctx.chatActions.includes('typing'), 'the indicator should have been shown');
  assert.ok(
    ctx.replies.some((r) => typeof r === 'string' && /couldn't|could not|failed|try again/i.test(r)),
    'the user is told it failed rather than being left waiting'
  );
});

test('filter highlights on channel posts are escaped and unattributed', async () => {
  const user = { id: 709, first_name: 'Filtered' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });
  db.setUserFilters(user.id, { keywords: [], categories: ['Tech'] });
  const chan = db.getOrCreateChannel({ username: 'filterchan', title: 'Filter Chan' });
  db.linkUserToChat(chan.id, user.id);

  const ctx = await fireCallback(`summary:chat:${chan.id}:24`, { from: user, subscription: PREMIUM });
  const body = ctx.replies.find((r) => typeof r === 'string' && r.includes('stub summary'));

  assert.match(body, /нейросети/, 'the Russian tech post is highlighted');
  assert.ok(!/someone/.test(body), 'channel posts have no author to attribute');
});
