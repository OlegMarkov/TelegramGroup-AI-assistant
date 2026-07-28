const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-analytics-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';
process.env.ADMIN_USER_IDS = '900';

const db = require('../src/services/database');
const { track, getFunnelReport, EVENTS } = require('../src/services/analytics');
const registerStats = require('../src/commands/stats');

test.after(() => {
  db.db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

test('track() records an event that getFunnelReport picks up', () => {
  db.getOrCreateUser({ id: 500, username: 'a', firstName: 'A' });
  track(EVENTS.USER_STARTED, { userId: 500 });

  const report = getFunnelReport(30);
  const entry = report.counts.find((c) => c.event_type === EVENTS.USER_STARTED);
  assert.ok(entry);
  assert.equal(entry.count, 1);
  assert.equal(entry.unique_users, 1);
});

test('track() never throws even if it references a nonexistent user (FK violation is swallowed)', () => {
  assert.doesNotThrow(() => track(EVENTS.USER_STARTED, { userId: 999999 }));
});

test('getFunnelReport computes paywall -> purchase conversion correctly', () => {
  db.getOrCreateUser({ id: 501, username: 'b', firstName: 'B' }); // hits a wall, converts
  db.getOrCreateUser({ id: 502, username: 'c', firstName: 'C' }); // hits a wall, never converts
  db.getOrCreateUser({ id: 503, username: 'd', firstName: 'D' }); // purchases without ever hitting a wall

  track(EVENTS.SUMMARY_BLOCKED_DAILY_LIMIT, { userId: 501 });
  track(EVENTS.SUBSCRIPTION_PURCHASED, { userId: 501, metadata: { plan: 'monthly' } });

  track(EVENTS.DIGEST_BLOCKED_PREMIUM, { userId: 502 });

  track(EVENTS.SUBSCRIPTION_PURCHASED, { userId: 503, metadata: { plan: 'yearly' } });

  const report = getFunnelReport(30);
  assert.equal(report.paywallHitUsers, 2, 'users 501 and 502 both hit a paywall event');
  assert.equal(report.convertedFromPaywall, 1, 'only user 501 both hit a wall and purchased');
  assert.equal(report.totalPurchasers, 2, 'users 501 and 503 both purchased');
});

test('/stats replies for an admin and stays silent for a non-admin', async () => {
  db.getOrCreateUser({ id: 900, username: 'admin', firstName: 'Admin' });
  db.getOrCreateUser({ id: 901, username: 'regular', firstName: 'Regular' });
  track(EVENTS.USER_STARTED, { userId: 900 });

  const handlers = {};
  const fakeBot = {
    command(name, fn) {
      handlers[name] = fn;
    },
  };
  registerStats(fakeBot);

  function makeCtx(from, text) {
    const replies = [];
    return {
      from,
      message: { text },
      replies,
      reply: async (msg) => {
        replies.push(msg);
        return { message_id: 1 };
      },
    };
  }

  const adminCtx = makeCtx({ id: 900 }, '/stats');
  await handlers.stats(adminCtx);
  assert.equal(adminCtx.replies.length, 1);
  assert.match(adminCtx.replies[0], /Analytics/);

  const regularCtx = makeCtx({ id: 901 }, '/stats');
  await handlers.stats(regularCtx);
  assert.equal(regularCtx.replies.length, 0, 'a non-admin must get no reply at all');
});
