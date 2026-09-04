const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-admin-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

const ADMIN_ID = 4242;
process.env.ADMIN_USER_IDS = String(ADMIN_ID);

const db = require('../src/services/database');
const registerAdmin = require('../src/commands/admin');
const { formatDate } = require('../src/utils/formatters');

const handlers = {};
registerAdmin({
  command(name, fn) {
    handlers[name] = fn;
  },
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

function makeCtx({ text, from = ADMIN_ID, refund }) {
  const replies = [];
  const apiCalls = [];
  return {
    from: { id: from },
    chat: { id: from, type: 'private' },
    message: { text },
    replies,
    apiCalls,
    telegram: {
      callApi: async (method, payload) => {
        apiCalls.push({ method, payload });
        if (refund instanceof Error) throw refund;
        return true;
      },
    },
    reply: async (msg) => {
      replies.push(msg);
      return { message_id: 1 };
    },
  };
}

async function run(command, opts) {
  const ctx = makeCtx(opts);
  await handlers[command](ctx);
  return ctx;
}

function paidSubscription(userId, chargeId) {
  db.getOrCreateUser({ id: userId, username: `u${userId}`, firstName: 'U' });
  return db.createSubscription({
    userId,
    plan: 'monthly',
    starsPaid: 300,
    telegramChargeId: chargeId,
    expiresAt: formatDate(new Date(Date.now() + 30 * 86400000)),
  });
}

test('a refund calls Telegram, then takes access away', async () => {
  const userId = 600;
  const subscription = paidSubscription(userId, 'charge-refund-600');
  assert.ok(db.getActiveSubscription(userId), 'they start out with access');

  const ctx = await run('refund', { text: '/refund charge-refund-600' });

  assert.deepEqual(ctx.apiCalls, [
    { method: 'refundStarPayment', payload: { user_id: userId, telegram_payment_charge_id: 'charge-refund-600' } },
  ]);

  const row = db.db.prepare('SELECT status FROM subscriptions WHERE id = ?').get(subscription.id);
  assert.equal(row.status, 'refunded');
  assert.equal(db.getActiveSubscription(userId), undefined, 'a refunded subscription stops granting access');
});

test('a refund Telegram refuses changes nothing at all', async () => {
  const userId = 601;
  paidSubscription(userId, 'charge-refund-601');

  const ctx = await run('refund', {
    text: '/refund charge-refund-601',
    refund: new Error('BALANCE_TOO_LOW'),
  });

  assert.ok(db.getActiveSubscription(userId), 'access survives a refund that never happened');
  assert.match(ctx.replies[0], /Nothing was changed/);
});

test('a grant creates a NULL-charge row that does not trip the unique index', async () => {
  // The live bug, from the other side: two comps inserted with the same
  // placeholder charge id are what stopped the unique index being created.
  // Grants must never write a placeholder, so two of them can coexist.
  const first = 602;
  const second = 603;

  await run('grant', { text: `/grant ${first} 30` });
  await run('grant', { text: `/grant ${second} 90` });

  for (const userId of [first, second]) {
    const row = db.db.prepare('SELECT * FROM subscriptions WHERE user_id = ?').get(userId);
    assert.equal(row.telegram_charge_id, null, 'a placeholder here is what broke the index');
    assert.equal(row.stars_paid, 0);
    assert.ok(db.getActiveSubscription(userId), 'a grant gives real access');
  }

  // And the index is genuinely in place, rather than silently absent.
  assert.equal(db.nullPlaceholderChargeIds(), 0);
  assert.equal(db.ensureChargeIdIndex(), true);
});

test('a grant reaches someone who has never opened the bot', async () => {
  // Foreign keys are on, so the users row has to exist first.
  const stranger = 604;
  await run('grant', { text: `/grant ${stranger} 7` });
  assert.ok(db.getActiveSubscription(stranger));
});

test('a revoke takes effect immediately, across every active row', async () => {
  const userId = 605;
  paidSubscription(userId, 'charge-revoke-605-a');
  paidSubscription(userId, 'charge-revoke-605-b');
  assert.ok(db.getActiveSubscription(userId));

  const ctx = await run('revoke', { text: `/revoke ${userId}` });

  assert.equal(db.getActiveSubscription(userId), undefined);
  assert.match(ctx.replies[0], /Revoked 2 subscription/);

  const statuses = db.db
    .prepare('SELECT status FROM subscriptions WHERE user_id = ? ORDER BY id')
    .all(userId)
    .map((r) => r.status);
  assert.deepEqual(statuses, ['revoked', 'revoked']);
});

test('getActiveSubscription ignores refunded and revoked rows, which is what makes all this work', () => {
  // Stated directly rather than only through the commands: every one of them
  // depends on this filter, and nothing else was testing it.
  const userId = 606;
  const subscription = paidSubscription(userId, 'charge-status-606');

  db.setSubscriptionStatus(subscription.id, 'refunded');
  assert.equal(db.getActiveSubscription(userId), undefined);

  db.setSubscriptionStatus(subscription.id, 'revoked');
  assert.equal(db.getActiveSubscription(userId), undefined);

  db.setSubscriptionStatus(subscription.id, 'active');
  assert.ok(db.getActiveSubscription(userId), 'and an active one still counts');
});

test('every admin command is silent for a non-admin', async () => {
  const outsider = 607;
  paidSubscription(outsider, 'charge-outsider-607');

  for (const [command, text] of [
    ['refund', '/refund charge-outsider-607'],
    ['grant', `/grant ${outsider} 30`],
    ['revoke', `/revoke ${outsider}`],
  ]) {
    const ctx = await run(command, { text, from: outsider });
    assert.deepEqual(ctx.replies, [], `/${command} must not even acknowledge a non-admin`);
    assert.deepEqual(ctx.apiCalls, []);
  }

  assert.ok(db.getActiveSubscription(outsider), 'and nothing they sent had any effect');
});

test('the admin commands are absent from the published command menu', () => {
  const { PUBLIC_COMMANDS } = require('../src/utils/i18n');
  for (const command of ['refund', 'grant', 'revoke']) {
    assert.ok(!PUBLIC_COMMANDS.includes(command), `/${command} must stay undiscoverable`);
  }
});

test('bad arguments are refused rather than acted on', async () => {
  const usages = [
    ['refund', '/refund'],
    ['grant', '/grant notanumber 30'],
    ['grant', '/grant 608 0'],
    ['grant', '/grant 608 -5'],
    ['revoke', '/revoke everyone'],
  ];

  for (const [command, text] of usages) {
    const ctx = await run(command, { text });
    assert.match(ctx.replies[0], /Usage:/, `"${text}" should print usage`);
  }

  assert.equal(
    db.db.prepare('SELECT COUNT(*) c FROM subscriptions WHERE user_id = 608').get().c,
    0,
    'a rejected grant creates nothing'
  );
});
