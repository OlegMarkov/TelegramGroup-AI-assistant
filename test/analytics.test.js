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

test('retention excludes users too new to have qualified', () => {
  // The trap: a user who signed up an hour ago cannot have 7-day retention
  // yet. Counting them in the denominator makes every new signup look like
  // churn, so growth would read as a retention collapse.
  db.db.prepare("INSERT INTO users (id, first_name, created_at) VALUES (800, 'Old', datetime('now','-40 days'))").run();
  db.db.prepare("INSERT INTO users (id, first_name, created_at) VALUES (801, 'New', datetime('now','-1 hours'))").run();

  // The old user came back on day 10 — retained at D1 and D7, not at D30.
  db.db
    .prepare("INSERT INTO events (user_id, event_type, created_at) VALUES (800, 'summary_requested', datetime('now','-30 days'))")
    .run();
  // The brand-new user has done nothing since joining.

  const curve = db.getRetentionCurve([1, 7, 30]);
  const byDay = Object.fromEntries(curve.map((c) => [c.days, c]));

  assert.equal(byDay[1].eligible, 1, 'only the 40-day-old user is eligible for D1; the 1-hour-old user is not');
  assert.equal(byDay[1].retained, 1, 'the old user acted 10 days after joining, so counts as retained');

  assert.equal(byDay[30].eligible, 1, 'the old user is eligible for D30');
  assert.equal(byDay[30].retained, 0, 'their only activity was on day 10, before the D30 threshold');

  assert.equal(byDay[1].pct, 100);
  assert.equal(byDay[30].pct, 0);
});

test('retention reports null rather than 0% when nobody is eligible yet', () => {
  // Distinguishing "no data" from "0% retention" matters: the first is normal
  // for a young product, the second means users are leaving.
  const [d] = db.getRetentionCurve([3650]); // nobody is 10 years old
  assert.equal(d.eligible, 0);
  assert.equal(d.pct, null, 'no eligible users must not be reported as 0% retention');
});

test('weekly cohorts group users by signup week with per-cohort retention', () => {
  const cohorts = db.getWeeklyCohorts(8);
  assert.ok(cohorts.length > 0);

  for (const c of cohorts) {
    assert.match(c.cohort_start, /^\d{4}-\d{2}-\d{2}$/, 'cohort key should be the Monday of that week');
    assert.ok(c.size > 0);
    assert.ok(c.retained_d1 <= c.eligible_d1, 'retained can never exceed the eligible denominator');
    assert.ok(c.retained_d7 <= c.eligible_d7);
    assert.ok(c.eligible_d1 <= c.size, 'eligible can never exceed cohort size');
  }
});

test('getDailyActiveUsers counts distinct users per day and ignores anonymized events', () => {
  db.db.prepare("INSERT INTO events (user_id, event_type, created_at) VALUES (NULL, 'summary_requested', datetime('now'))").run();
  const daily = db.getDailyActiveUsers(14);

  for (const row of daily) {
    assert.ok(row.active_users >= 0);
    assert.ok(row.events >= row.active_users, 'a user can generate several events in a day');
  }
  // A /forgetme-anonymized event still counts as activity but has no user.
  const today = daily.find((r) => r.day === new Date().toISOString().slice(0, 10));
  if (today) assert.ok(today.events > 0);
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
