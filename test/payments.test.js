const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-payments-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

const db = require('../src/services/database');
const { handlePreCheckoutQuery, handleSuccessfulPayment } = require('../src/services/payments');
const registerSubscribe = require('../src/commands/subscribe');
const { SUBSCRIPTION_PLANS } = require('../src/models/subscription');

const handlers = { commands: {}, actions: [] };
registerSubscribe({
  command(name, fn) {
    handlers.commands[name] = fn;
  },
  hears() {},
  action(pattern, fn) {
    handlers.actions.push({ pattern, fn });
  },
});

test.after(() => {
  db.db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

function makeCtx({ userId, subscription }) {
  const calls = { invoices: [], replies: [], cbAnswers: [], preCheckout: [] };
  return {
    calls,
    from: { id: userId },
    state: { subscription: subscription || null, lang: 'en' },
    replyWithInvoice: async (inv) => {
      calls.invoices.push(inv);
      return { message_id: 1 };
    },
    reply: async (msg) => {
      calls.replies.push(msg);
      return { message_id: 1 };
    },
    answerCbQuery: async (msg) => calls.cbAnswers.push(msg || ''),
    answerPreCheckoutQuery: async (ok, msg) => calls.preCheckout.push({ ok, msg }),
  };
}

function fireAction(data, ctxOpts) {
  for (const { pattern, fn } of handlers.actions) {
    const match = pattern.exec(data);
    if (match) {
      const ctx = makeCtx(ctxOpts);
      ctx.match = match;
      return fn(ctx).then(() => ctx);
    }
  }
  throw new Error(`no handler for ${data}`);
}

function daysFromNow(days) {
  return db.db.prepare('SELECT datetime(?, ?) AS d').get('now', `${days >= 0 ? '+' : ''}${days} days`).d;
}

test('a stale plan button does not bill an active subscriber again', async () => {
  // /subscribe refuses to show the menu to a subscriber, but a message sent
  // before they paid still has live buttons sitting in their chat history.
  const ctx = await fireAction('subscribe:monthly', {
    userId: 801,
    subscription: { plan: 'monthly', expires_at: daysFromNow(20) },
  });

  assert.equal(ctx.calls.invoices.length, 0, 'no invoice may be sent to an active subscriber');
  assert.equal(ctx.calls.cbAnswers.length, 1);
  assert.match(ctx.calls.cbAnswers[0], /already subscribed/i);
});

test('a user without a subscription still gets their invoice', async () => {
  const ctx = await fireAction('subscribe:monthly', { userId: 802, subscription: null });

  assert.equal(ctx.calls.invoices.length, 1);
  assert.equal(ctx.calls.invoices[0].currency, 'XTR');
  assert.equal(ctx.calls.invoices[0].prices[0].amount, SUBSCRIPTION_PLANS.monthly.stars);
});

test('pre-checkout declines a purchase from someone already subscribed', async () => {
  // The last gate before money moves. Declining here means never charged,
  // rather than charged and needing a refund.
  db.getOrCreateUser({ id: 803, firstName: 'Active' });
  db.createSubscription({ userId: 803, plan: 'yearly', starsPaid: 3000, expiresAt: daysFromNow(300) });

  const ctx = makeCtx({ userId: 803 });
  ctx.preCheckoutQuery = { invoice_payload: 'subscription:monthly:803' };
  await handlePreCheckoutQuery(ctx);

  assert.equal(ctx.calls.preCheckout.length, 1);
  assert.equal(ctx.calls.preCheckout[0].ok, false, 'the purchase must be declined');
  assert.match(ctx.calls.preCheckout[0].msg, /already subscribed/i);
});

test('pre-checkout approves a genuine first purchase', async () => {
  db.getOrCreateUser({ id: 804, firstName: 'New' });

  const ctx = makeCtx({ userId: 804 });
  ctx.preCheckoutQuery = { invoice_payload: 'subscription:monthly:804' };
  await handlePreCheckoutQuery(ctx);

  assert.equal(ctx.calls.preCheckout[0].ok, true);
});

test('pre-checkout still rejects a malformed payload', async () => {
  const ctx = makeCtx({ userId: 805 });
  ctx.preCheckoutQuery = { invoice_payload: 'subscription:nonsense:805' };
  await handlePreCheckoutQuery(ctx);

  assert.equal(ctx.calls.preCheckout[0].ok, false);
});

test('a payment landing on an active subscription extends it instead of truncating it', async () => {
  // The expensive bug: getActiveSubscription returns the NEWEST row by
  // started_at, not the longest. Dating a new period from "now" would let a
  // 300-star monthly silently swallow the rest of a 3000-star yearly.
  db.getOrCreateUser({ id: 806, firstName: 'Yearly' });
  const remaining = daysFromNow(300);
  db.createSubscription({ userId: 806, plan: 'yearly', starsPaid: 3000, expiresAt: remaining });

  const ctx = makeCtx({ userId: 806 });
  ctx.message = {
    successful_payment: {
      invoice_payload: 'subscription:monthly:806',
      total_amount: SUBSCRIPTION_PLANS.monthly.stars,
      telegram_payment_charge_id: 'charge-806',
    },
  };
  await handleSuccessfulPayment(ctx);

  const active = db.getActiveSubscription(806);
  assert.ok(
    active.expires_at > remaining,
    `expected the new expiry (${active.expires_at}) to be beyond the old one (${remaining})`
  );

  // 300 days remaining + 30 more, not 30 from today.
  const expected = daysFromNow(330);
  assert.equal(active.expires_at.slice(0, 10), expected.slice(0, 10), 'the paid-for time is added, not replaced');
});

test('the longest-running subscription decides access, not the newest', async () => {
  // A short plan bought or comped on top of a long one must not shorten the
  // user's access. started_at is also stored to the second, so two rows made
  // in the same second had no defined order at all.
  db.getOrCreateUser({ id: 809, firstName: 'Two' });
  const far = daysFromNow(300);
  db.createSubscription({ userId: 809, plan: 'yearly', starsPaid: 3000, expiresAt: far });
  db.createSubscription({ userId: 809, plan: 'monthly', starsPaid: 0, expiresAt: daysFromNow(5) });

  assert.equal(db.getActiveSubscription(809).expires_at, far, 'the longer subscription wins');
});

test('a never-expiring subscription outranks any dated one', () => {
  db.getOrCreateUser({ id: 810, firstName: 'Forever' });
  db.createSubscription({ userId: 810, plan: 'monthly', starsPaid: 300, expiresAt: daysFromNow(10) });
  db.createSubscription({ userId: 810, plan: 'yearly', starsPaid: 0, expiresAt: null });

  assert.equal(db.getActiveSubscription(810).expires_at, null, 'NULL means never expires, so it wins');
});

test('a first purchase is dated from now, not from some earlier row', async () => {
  db.getOrCreateUser({ id: 807, firstName: 'First' });

  const ctx = makeCtx({ userId: 807 });
  ctx.message = {
    successful_payment: {
      invoice_payload: 'subscription:monthly:807',
      total_amount: 300,
      telegram_payment_charge_id: 'charge-807',
    },
  };
  await handleSuccessfulPayment(ctx);

  const active = db.getActiveSubscription(807);
  assert.equal(active.expires_at.slice(0, 10), daysFromNow(30).slice(0, 10));
});

test('an expired subscription does not extend a new purchase', async () => {
  // Extending from a lapsed expiry would date the new period in the past.
  db.getOrCreateUser({ id: 808, firstName: 'Lapsed' });
  db.createSubscription({ userId: 808, plan: 'monthly', starsPaid: 300, expiresAt: daysFromNow(-40) });

  const ctx = makeCtx({ userId: 808 });
  ctx.message = {
    successful_payment: {
      invoice_payload: 'subscription:monthly:808',
      total_amount: 300,
      telegram_payment_charge_id: 'charge-808',
    },
  };
  await handleSuccessfulPayment(ctx);

  const active = db.getActiveSubscription(808);
  assert.equal(active.expires_at.slice(0, 10), daysFromNow(30).slice(0, 10), 'dated from today');
});
