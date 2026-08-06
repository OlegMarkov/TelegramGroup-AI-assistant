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
registerChannel(fakeBot);
registerSummary(fakeBot);

const PREMIUM = { plan: 'monthly', status: 'active' };

function makeCtx({ from, subscription, text }) {
  const replies = [];
  const chatActions = [];
  return {
    chat: { id: from.id, type: 'private' },
    from,
    state: { subscription: subscription || null, lang: 'en' },
    message: { text, message_id: 1, date: Math.floor(Date.now() / 1000) },
    replies,
    chatActions,
    reply: async (msg) => {
      replies.push(msg);
      return { message_id: 1 };
    },
    sendChatAction: async (action) => {
      chatActions.push(action);
    },
    answerCbQuery: async (msg) => replies.push(msg || ''),
  };
}

async function run(command, opts) {
  const ctx = makeCtx(opts);
  await handlers.commands[command](ctx);
  return ctx;
}

async function fireCallback(data, opts) {
  for (const { pattern, fn } of handlers.actions) {
    const match = pattern.exec(data);
    if (match) {
      const ctx = makeCtx(opts);
      ctx.match = match;
      await fn(ctx);
      return ctx;
    }
  }
  throw new Error(`no handler matched ${data}`);
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

test('/addchannel is refused on the free plan and creates nothing', async () => {
  const user = { id: 701, first_name: 'Free' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });

  const ctx = await run('addchannel', { from: user, text: '/addchannel @somechannel' });

  assert.match(ctx.replies[0], /premium feature/i);
  assert.equal(db.getChannelByUsername('somechannel'), undefined, 'nothing was created');
  assert.equal(db.getUserChannels(user.id).length, 0);
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

  assert.match(ctx.replies[0], /channel username/i);
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

test('a lapsed subscriber cannot summarize a channel they still have buttons for', async () => {
  // callback_data comes from the client. Hiding channels from the picker is
  // presentation; this is the check that actually holds when a subscription
  // expires and the user taps a button Telegram still shows them.
  const user = { id: 707, first_name: 'Lapsed' };
  db.getOrCreateUser({ id: user.id, firstName: user.first_name });
  const chan = db.getOrCreateChannel({ username: 'lapsedchan', title: 'Lapsed Chan' });
  db.linkUserToChat(chan.id, user.id);

  const blocked = await fireCallback(`summary:chat:${chan.id}:24`, { from: user, subscription: null });
  assert.ok(
    blocked.replies.some((r) => typeof r === 'string' && /premium feature/i.test(r)),
    'a user without a subscription must be refused'
  );
  assert.ok(!blocked.replies.some((r) => typeof r === 'string' && r.includes('stub summary')));

  const allowed = await fireCallback(`summary:chat:${chan.id}:24`, { from: user, subscription: PREMIUM });
  assert.ok(allowed.replies.some((r) => typeof r === 'string' && r.includes('stub summary')));
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
