const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-ratelimit-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

const db = require('../src/services/database');
const rateLimit = require('../src/middleware/rateLimit');

test.after(() => {
  db.db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

function makeCtx({ userId, languageCode, lang }) {
  const replies = [];
  return {
    replies,
    updateType: 'message',
    chat: { id: userId, type: 'private' },
    from: { id: userId, language_code: languageCode },
    message: { text: 'hello' },
    state: lang ? { lang } : {},
    reply: async (msg) => {
      replies.push(msg);
      return { message_id: replies.length };
    },
  };
}

/** Sends `count` messages through the middleware and returns the last context. */
async function flood(middleware, ctxFactory, count) {
  let ctx;
  for (let i = 0; i < count; i += 1) {
    ctx = ctxFactory();
    // eslint-disable-next-line no-await-in-loop
    await middleware(ctx, async () => {});
  }
  return ctx;
}

test('the refusal is localized to a stored /language choice', async () => {
  // This middleware runs ahead of auth(), so ctx.state.lang is not set yet —
  // the language has to come from the user's own record, or a Russian speaker
  // gets the one English string in the whole bot.
  db.getOrCreateUser({ id: 601, username: 'ru', firstName: 'R', language: 'ru' });

  const middleware = rateLimit({ windowMs: 60000, maxRequests: 2 });
  const ctx = await flood(middleware, () => makeCtx({ userId: 601, languageCode: 'en' }), 3);

  assert.equal(ctx.replies.length, 1, 'only the over-limit request is refused');
  assert.match(ctx.replies[0], /Слишком много запросов/);
  assert.ok(!/Too many/.test(ctx.replies[0]), 'the stored choice wins over the client locale');
});

test('a user we have never seen is refused in their client language', async () => {
  const middleware = rateLimit({ windowMs: 60000, maxRequests: 1 });
  const ctx = await flood(middleware, () => makeCtx({ userId: 602, languageCode: 'ru-RU' }), 2);

  assert.match(ctx.replies[0], /Слишком много запросов/);
});

test('an unsupported client language falls back to English rather than a raw key', async () => {
  const middleware = rateLimit({ windowMs: 60000, maxRequests: 1 });
  const ctx = await flood(middleware, () => makeCtx({ userId: 603, languageCode: 'de' }), 2);

  assert.match(ctx.replies[0], /Too many requests/);
  assert.ok(!/common\.tooManyRequests/.test(ctx.replies[0]), 'a missing key would render as its own name');
});

test('the retry hint counts down in seconds', async () => {
  const middleware = rateLimit({ windowMs: 10000, maxRequests: 1 });
  const ctx = await flood(middleware, () => makeCtx({ userId: 604, languageCode: 'en' }), 2);

  assert.match(ctx.replies[0], /\d+s\./);
});

test('requests under the limit pass straight through', async () => {
  const middleware = rateLimit({ windowMs: 60000, maxRequests: 5 });
  let passed = 0;
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await middleware(makeCtx({ userId: 605, languageCode: 'en' }), async () => {
      passed += 1;
    });
  }
  assert.equal(passed, 5);
});

test('group chatter is not rate limited, only DMs and commands', async () => {
  const middleware = rateLimit({ windowMs: 60000, maxRequests: 1 });
  let passed = 0;

  for (let i = 0; i < 10; i += 1) {
    const ctx = makeCtx({ userId: 606, languageCode: 'en' });
    ctx.chat = { id: -1, type: 'supergroup' };
    // eslint-disable-next-line no-await-in-loop
    await middleware(ctx, async () => {
      passed += 1;
    });
  }

  assert.equal(passed, 10, 'passive ingestion must never be throttled');
});

test('the tracking map does not grow without bound', async () => {
  // One entry per user id, added forever, was a slow leak that grew with every
  // person who ever touched the bot.
  const { trackedUsers } = rateLimit;
  trackedUsers.clear();

  // Seeded rather than produced by a fast loop: sixty real requests all land
  // inside the same millisecond, so nothing would actually have expired yet
  // and the test would be asserting on the clock instead of on the sweep.
  for (let i = 0; i < 60; i += 1) {
    trackedUsers.set(10000 + i, { count: 1, resetAt: Date.now() - 1000 });
  }

  const middleware = rateLimit({ windowMs: 60000, maxRequests: 10, sweepThreshold: 50 });
  await middleware(makeCtx({ userId: 999, languageCode: 'en' }), async () => {});

  assert.equal(
    trackedUsers.size,
    1,
    `every elapsed window must be reclaimed, leaving only the live caller; held ${trackedUsers.size}`
  );

  trackedUsers.clear();
});

test('sweeping never drops a window that is still open', async () => {
  const { trackedUsers } = rateLimit;
  trackedUsers.clear();

  const middleware = rateLimit({ windowMs: 60000, maxRequests: 10, sweepThreshold: 5 });
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await middleware(makeCtx({ userId: 20000 + i, languageCode: 'en' }), async () => {});
  }

  assert.equal(trackedUsers.size, 20, 'live windows are still being counted');
  trackedUsers.clear();
});
