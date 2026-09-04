const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BOT_TOKEN = 'test-token';
process.env.NODE_ENV = 'test';

const { armPrompt, clearPrompt, takePrompt, captureReply, createSelectionStore } = require('../src/utils/uiState');

function ctxFor(text, { userId = 1, chatType = 'private' } = {}) {
  return {
    chat: { id: userId, type: chatType },
    from: { id: userId },
    message: { text },
  };
}

async function feed(middleware, ctx) {
  let passedThrough = false;
  const taken = [];
  await middleware(ctx, async () => {
    passedThrough = true;
  });
  return { passedThrough, taken };
}

function capture(kind, seen) {
  return captureReply(kind, async (ctx, text) => {
    seen.push(text);
  });
}

test('a prompt is answered once, by the feature that asked', async () => {
  const channelSeen = [];
  const channel = capture('channel:add', channelSeen);

  armPrompt(10, 'channel:add');
  const first = await feed(channel, ctxFor('@durov', { userId: 10 }));
  assert.equal(first.passedThrough, false);
  assert.deepEqual(channelSeen, ['@durov']);

  // Consumed: the next message is an ordinary message again.
  const second = await feed(channel, ctxFor('just talking', { userId: 10 }));
  assert.equal(second.passedThrough, true);
  assert.deepEqual(channelSeen, ['@durov'], 'and it was not handed over a second time');
});

test('one feature never takes the answer to another feature question', async () => {
  const channelSeen = [];
  const filterSeen = [];
  const channel = capture('channel:add', channelSeen);
  const filter = capture('filter:keyword', filterSeen);

  armPrompt(11, 'filter:keyword');

  // Both middlewares are registered, and the message passes through the wrong
  // one before reaching the right one — which is how they sit in the bot.
  const ctx = ctxFor('deploy', { userId: 11 });
  const viaChannel = await feed(channel, ctx);
  assert.equal(viaChannel.passedThrough, true, 'the channel capture declined it');
  assert.deepEqual(channelSeen, []);

  await feed(filter, ctx);
  assert.deepEqual(filterSeen, ['deploy']);
});

test('asking a second question replaces the first, because a person answers the last one', async () => {
  const channelSeen = [];
  const filterSeen = [];

  armPrompt(12, 'channel:add');
  armPrompt(12, 'filter:keyword');

  const viaChannel = await feed(capture('channel:add', channelSeen), ctxFor('deploy', { userId: 12 }));
  assert.equal(viaChannel.passedThrough, true, 'the abandoned question no longer claims anything');

  await feed(capture('filter:keyword', filterSeen), ctxFor('deploy', { userId: 12 }));
  assert.deepEqual(filterSeen, ['deploy']);
});

test('clearPrompt only drops the question it names', () => {
  armPrompt(13, 'channel:add');
  clearPrompt(13, 'filter:keyword');
  assert.equal(takePrompt(13, 'channel:add'), true, 'an unrelated cancel left it standing');

  armPrompt(13, 'channel:add');
  clearPrompt(13, 'channel:add');
  assert.equal(takePrompt(13, 'channel:add'), false);
});

test('commands, menu taps and group chatter are always passed through', async () => {
  const seen = [];
  const middleware = capture('channel:add', seen);

  for (const text of ['/summary', '⭐ Subscribe', '📢 Channels', '🎯 Фильтры']) {
    armPrompt(14, 'channel:add');
    const result = await feed(middleware, ctxFor(text, { userId: 14 }));
    assert.equal(result.passedThrough, true, `${text} should never be taken as an answer`);
  }

  armPrompt(14, 'channel:add');
  const inGroup = await feed(middleware, ctxFor('anything', { userId: 14, chatType: 'supergroup' }));
  assert.equal(inGroup.passedThrough, true, 'in a group the next message is somebody talking');

  assert.deepEqual(seen, []);
});

test('a prompt that has expired is not answered', async () => {
  const seen = [];
  armPrompt(15, 'channel:add');

  // Reach past the clock rather than waiting five minutes for it.
  const realNow = Date.now;
  Date.now = () => realNow() + 6 * 60 * 1000;
  try {
    const result = await feed(capture('channel:add', seen), ctxFor('@durov', { userId: 15 }));
    assert.equal(result.passedThrough, true);
    assert.deepEqual(seen, []);
  } finally {
    Date.now = realNow;
  }
});

test('selections are per user, and cleared sets do not linger', () => {
  const store = createSelectionStore();

  store.set(20, new Set([1, 2]));
  store.set(21, new Set([3]));

  assert.deepEqual([...store.get(20)], [1, 2]);
  assert.deepEqual([...store.get(21)], [3], "one user's ticks never show up for another");

  store.clear(20);
  assert.equal(store.get(20).size, 0);
  assert.deepEqual([...store.get(21)], [3]);

  // Setting an empty set drops the entry rather than keeping an empty one alive.
  store.set(21, new Set());
  assert.equal(store.get(21).size, 0);
});

test('a selection is forgotten once it goes stale', () => {
  const store = createSelectionStore(1000);
  store.set(22, new Set(['a']));

  const realNow = Date.now;
  Date.now = () => realNow() + 2000;
  try {
    assert.equal(store.get(22).size, 0, 'an abandoned screen does not act on old ticks');
  } finally {
    Date.now = realNow;
  }
});
