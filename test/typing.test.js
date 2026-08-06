const test = require('node:test');
const assert = require('node:assert/strict');

process.env.BOT_TOKEN = 'test-token';
process.env.NODE_ENV = 'test';

const { startTyping } = require('../src/utils/typing');

function makeCtx(sendChatAction) {
  const calls = [];
  return {
    calls,
    sendChatAction: sendChatAction || (async (action) => {
      calls.push(action);
    }),
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('the indicator appears immediately, without waiting for the first interval', async () => {
  // A 4-second delay before any feedback would defeat the point.
  const ctx = makeCtx();
  const stop = startTyping(ctx, { intervalMs: 10_000 });
  try {
    assert.deepEqual(ctx.calls, ['typing']);
  } finally {
    stop();
  }
});

test('the indicator is refreshed, because Telegram clears it after ~5s', async () => {
  const ctx = makeCtx();
  const stop = startTyping(ctx, { intervalMs: 20 });
  await wait(110);
  stop();

  assert.ok(ctx.calls.length >= 4, `expected repeated refreshes, got ${ctx.calls.length}`);
  assert.ok(ctx.calls.every((a) => a === 'typing'));
});

test('stop() ends the refreshes', async () => {
  const ctx = makeCtx();
  const stop = startTyping(ctx, { intervalMs: 20 });
  await wait(60);
  stop();
  const atStop = ctx.calls.length;

  await wait(80);
  assert.equal(ctx.calls.length, atStop, 'no further actions after stop()');
});

test('a rejected chat action never surfaces as an unhandled rejection', async () => {
  // The indicator is cosmetic. If Telegram rejects it — blocked bot, stale
  // callback message — the summary must still be delivered.
  const ctx = makeCtx(async () => {
    throw new Error('Forbidden: bot was blocked by the user');
  });

  const stop = startTyping(ctx, { intervalMs: 10 });
  await wait(50);
  assert.doesNotThrow(stop);
});

test('a synchronously throwing chat action is contained too', () => {
  const ctx = makeCtx(() => {
    throw new Error('sync boom');
  });
  assert.doesNotThrow(() => {
    const stop = startTyping(ctx, { intervalMs: 10_000 });
    stop();
  });
});

test('a context that cannot send chat actions is a no-op, not a crash', () => {
  assert.doesNotThrow(() => startTyping(undefined)());
  assert.doesNotThrow(() => startTyping({})());
  assert.doesNotThrow(() => startTyping({ sendChatAction: 'not a function' })());
});

test('the refresh timer cannot hold the process open', () => {
  // An unref'd timer still lets the event loop drain at shutdown even if some
  // path forgets to stop it.
  const ctx = makeCtx();
  const realSetInterval = global.setInterval;
  let unrefCalled = false;

  global.setInterval = (...args) => {
    const timer = realSetInterval(...args);
    const realUnref = timer.unref.bind(timer);
    timer.unref = () => {
      unrefCalled = true;
      return realUnref();
    };
    return timer;
  };

  try {
    startTyping(ctx, { intervalMs: 10_000 })();
    assert.ok(unrefCalled, 'the interval must be unref\'d');
  } finally {
    global.setInterval = realSetInterval;
  }
});
