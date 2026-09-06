const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-trial-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

const db = require('../src/services/database');
const registerStart = require('../src/commands/start');
const {
  FREE_LIMITS,
  PREMIUM_LIMITS,
  SUBSCRIPTION_PLANS,
  TRIAL_PLAN,
  TRIAL_DAYS,
  getLimits,
} = require('../src/models/subscription');
const { formatDate } = require('../src/utils/formatters');

let startHandler;
registerStart({
  start(fn) {
    startHandler = fn;
  },
  command() {},
  hears() {},
  action() {},
});

test.after(() => {
  db.db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

function makeCtx(userId, lang = 'en') {
  const replies = [];
  return {
    from: { id: userId, first_name: 'New' },
    chat: { id: userId, type: 'private' },
    message: { text: '/start' },
    state: { lang, subscription: null },
    replies,
    reply: async (text, extra) => {
      replies.push({ text, extra: extra || {} });
      return { message_id: 1 };
    },
  };
}

async function start(userId, lang) {
  db.getOrCreateUser({ id: userId, username: `u${userId}`, firstName: 'New' });
  const ctx = makeCtx(userId, lang);
  await startHandler(ctx);
  return ctx;
}

function subscriptionRows(userId) {
  return db.db.prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY id').all(userId);
}

test('a first /start grants a week of premium, and says so', async () => {
  const userId = 700;
  const ctx = await start(userId);

  const rows = subscriptionRows(userId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].plan, TRIAL_PLAN);
  assert.equal(rows[0].stars_paid, 0);
  assert.equal(rows[0].telegram_charge_id, null, 'a placeholder here is what broke the charge-id index once');

  // It is an ordinary active subscription, so everything premium simply works
  // with no special case anywhere else.
  const active = db.getActiveSubscription(userId);
  assert.ok(active);
  assert.equal(getLimits(active).scheduledDigests, true);
  assert.equal(getLimits(active).maxChannels, PREMIUM_LIMITS.maxChannels);

  assert.match(ctx.replies[0].text, new RegExp(`${TRIAL_DAYS}-day free trial`));
});

test('a second /start does not grant a second trial', async () => {
  const userId = 701;
  await start(userId);
  const after = await start(userId);

  assert.equal(subscriptionRows(userId).length, 1, 'one trial per person, ever');
  assert.doesNotMatch(after.replies[0].text, /free trial has started/, 'and it is not announced again');
});

test('somebody who has ever paid does not get a trial', async () => {
  // Handing one to a lapsed paying customer would be a discount for churning.
  const userId = 702;
  db.getOrCreateUser({ id: userId, firstName: 'Former' });
  db.createSubscription({
    userId,
    plan: 'monthly',
    starsPaid: 300,
    telegramChargeId: `charge-trial-${userId}`,
    expiresAt: formatDate(new Date(Date.now() - 86400000)), // lapsed yesterday
  });

  const ctx = await start(userId);

  assert.equal(subscriptionRows(userId).length, 1, 'no trial row was added');
  assert.doesNotMatch(ctx.replies[0].text, /free trial/);
});

test('a comped user does not get a trial on top', async () => {
  const userId = 703;
  db.getOrCreateUser({ id: userId, firstName: 'Comped' });
  db.createSubscription({ userId, plan: 'comp', starsPaid: 0, expiresAt: formatDate(new Date(Date.now() + 86400000)) });

  await start(userId);
  assert.equal(subscriptionRows(userId).length, 1);
});

test('trial is not purchasable', () => {
  // pre_checkout validates a purchase against SUBSCRIPTION_PLANS, so a 'trial'
  // entry there would make a week of premium buyable for zero stars.
  assert.equal(SUBSCRIPTION_PLANS[TRIAL_PLAN], undefined);
  assert.deepEqual(Object.keys(SUBSCRIPTION_PLANS).sort(), ['monthly', 'yearly']);
});

test('a lapsed trial falls back to the free plan, keeping the earliest items', async () => {
  // The "earliest N wins" rule, seen from the end of a trial: somebody who
  // added twenty channels keeps their first, and the rest wait.
  const userId = 704;
  await start(userId);

  // joined_at is set explicitly: "earliest N wins" orders by it, and three
  // links created in the same second fall through to the chat_id tiebreak,
  // which for negative Telegram ids picks the one added last.
  const joined = ['2020-01-01 00:00:00', '2020-01-02 00:00:00', '2020-01-03 00:00:00'];
  [[-7041, 'First'], [-7042, 'Second'], [-7043, 'Third']].forEach(([chatId, title], i) => {
    db.getOrCreateChat({ id: chatId, title, type: 'group' });
    db.linkUserToChat(chatId, userId);
    db.db
      .prepare('UPDATE chat_members SET joined_at = ? WHERE chat_id = ? AND user_id = ?')
      .run(joined[i], chatId, userId);
  });
  db.setUserFilters(userId, { keywords: ['alpha', 'beta', 'gamma'], categories: [] });

  // On trial, everything is live.
  const onTrial = getLimits(db.getActiveSubscription(userId));
  assert.equal(db.getAllowedUserChats(userId, onTrial.maxGroups).length, 3);

  // The trial runs out.
  db.db
    .prepare("UPDATE subscriptions SET expires_at = datetime('now', '-1 day') WHERE user_id = ?")
    .run(userId);
  assert.equal(db.getActiveSubscription(userId), undefined, 'it lapses like any other subscription');

  const free = getLimits(db.getActiveSubscription(userId));
  assert.equal(free.maxGroups, FREE_LIMITS.maxGroups);

  const allowed = db.getAllowedUserChats(userId, free.maxGroups);
  assert.equal(allowed.length, FREE_LIMITS.maxGroups);
  assert.equal(allowed[0].id, -7041, 'and it is the earliest one that stays');

  // Nothing was deleted — the rest are kept and come back on subscribing.
  assert.equal(db.getUserGroups(userId).length, 3);
  assert.equal(db.getUserFilters(userId).keywords.length, 3);
});

test('the trial is reminded about in its own words, not asked to renew', async () => {
  // The last day of a trial is the best moment there will ever be to ask for
  // the sale, and "renew your trial" is not the sentence that does it.
  const { t } = require('../src/utils/i18n');

  for (const lang of ['en', 'ru']) {
    for (const stage of ['expiring_3d', 'expiring_1d', 'expired']) {
      const key = `reminder.trial_${stage}`;
      const text = t(lang, key, {
        days: 3,
        expires: '2026-09-13',
        premiumChannels: PREMIUM_LIMITS.maxChannels,
        freeSummaries: FREE_LIMITS.maxSummariesPerDay,
        freeGroups: FREE_LIMITS.maxGroups,
        freeChannels: FREE_LIMITS.maxChannels,
        freeKeywords: FREE_LIMITS.maxKeywords,
      });
      assert.notEqual(text, key, `no ${lang} copy for ${key}`);
      assert.ok(!text.includes('{'), `${lang} ${key} has an unfilled placeholder`);
    }
  }
});

test('an expiring trial is picked up by the reminder query like any subscription', () => {
  const userId = 705;
  db.getOrCreateUser({ id: userId, firstName: 'Expiring' });
  db.createSubscription({
    userId,
    plan: TRIAL_PLAN,
    starsPaid: 0,
    telegramChargeId: null,
    expiresAt: formatDate(new Date(Date.now() + 2 * 86400000)),
  });

  const due = db.getSubscriptionsDueForReminder('expiring_3d', '+1 days', '+3 days');
  const row = due.find((s) => s.user_id === userId);
  assert.ok(row, 'a trial expiring in two days is due for the 3-day reminder');
  assert.equal(row.plan, TRIAL_PLAN, 'and the plan is what selects the trial wording');
});

test('two trials can coexist, because neither carries a charge id', () => {
  // The partial unique index is on telegram_charge_id. NULLs do not collide,
  // which is the whole reason a trial must not be given a placeholder.
  const a = 706;
  const b = 707;
  db.getOrCreateUser({ id: a, firstName: 'A' });
  db.getOrCreateUser({ id: b, firstName: 'B' });

  db.createSubscription({ userId: a, plan: TRIAL_PLAN, starsPaid: 0, telegramChargeId: null, expiresAt: null });
  db.createSubscription({ userId: b, plan: TRIAL_PLAN, starsPaid: 0, telegramChargeId: null, expiresAt: null });

  assert.equal(db.nullPlaceholderChargeIds(), 0);
  assert.equal(db.ensureChargeIdIndex(), true);
});
