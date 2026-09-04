const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-status-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

const db = require('../src/services/database');
const registerStatus = require('../src/commands/status');
const { FREE_LIMITS, PREMIUM_LIMITS } = require('../src/models/subscription');
const { t, SUPPORTED_LANGUAGES } = require('../src/utils/i18n');

const handlers = { commands: {}, actions: {} };
registerStatus({
  command(name, fn) {
    handlers.commands[name] = fn;
  },
  hears() {},
  action(name, fn) {
    handlers.actions[name] = fn;
  },
});

test.after(() => {
  db.db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

function makeCtx({ userId, lang = 'en', subscription = null, chat }) {
  const replies = [];
  return {
    chat: chat || { id: userId, type: 'private' },
    from: { id: userId },
    state: { lang, subscription },
    message: { text: '/status' },
    replies,
    reply: async (text, extra) => {
      replies.push({ text, extra: extra || {} });
      return { message_id: 1 };
    },
  };
}

async function runStatus(opts) {
  const ctx = makeCtx(opts);
  await handlers.commands.status(ctx);
  return ctx.replies[ctx.replies.length - 1];
}

function activeSubscription(userId, days = 30) {
  db.createSubscription({
    userId,
    plan: 'monthly',
    starsPaid: 300,
    telegramChargeId: `charge-status-${userId}`,
    expiresAt: new Date(Date.now() + days * 86400000).toISOString(),
  });
  return db.getActiveSubscription(userId);
}

test('a free user sees their plan and every allowance against its limit', async () => {
  const userId = 400;
  db.getOrCreateUser({ id: userId, username: 'free', firstName: 'F' });
  db.getOrCreateChat({ id: -400, title: 'One Group', type: 'group' });
  db.linkUserToChat(-400, userId);
  db.incrementSummaryUsage(userId);

  const { text } = await runStatus({ userId });

  assert.match(text, /Plan\*: Free/);
  assert.match(text, new RegExp(`Summaries today: 1 of ${FREE_LIMITS.maxSummariesPerDay}`));
  assert.match(text, new RegExp(`up to ${FREE_LIMITS.maxLookbackHours}h`));
  assert.match(text, new RegExp(`Groups: 1 of ${FREE_LIMITS.maxGroups}`));
  assert.match(text, new RegExp(`Channels: 0 of ${FREE_LIMITS.maxChannels}`));
  assert.match(text, /Not set up/);
});

test('a premium user sees unlimited as a word, never the string Infinity', async () => {
  const userId = 401;
  db.getOrCreateUser({ id: userId, username: 'paid', firstName: 'P' });
  const subscription = activeSubscription(userId);

  const { text } = await runStatus({ userId, subscription });

  assert.ok(!text.includes('Infinity'), 'PREMIUM_LIMITS holds real Infinity values; printing one is the bug');
  assert.match(text, new RegExp(`Summaries today: 0 of ${t('en', 'status.unlimited')}`));
  assert.match(text, new RegExp(`Groups: 0 of ${t('en', 'status.unlimited')}`));
  assert.match(text, new RegExp(`Channels: 0 of ${PREMIUM_LIMITS.maxChannels}`));
  assert.match(
    text,
    /until \d{4}-\d{2}-\d{2}$/m,
    'a paid plan says the day it runs out, without the seconds nobody asked for'
  );
});

test('a lapsed subscriber sees locked counts rather than an error', async () => {
  const userId = 402;
  db.getOrCreateUser({ id: userId, username: 'lapsed', firstName: 'L' });

  // Everything they built up on premium, still stored, now past the free
  // allowance — the "earliest N wins" rule, seen from the user's side.
  for (const [chatId, title] of [[-402, 'A Group'], [-403, 'B Group'], [-404, 'C Group']]) {
    db.getOrCreateChat({ id: chatId, title, type: 'group' });
    db.linkUserToChat(chatId, userId);
  }
  db.setUserFilters(userId, { keywords: ['alpha', 'beta', 'gamma'], categories: [] });

  // Deliberately no active subscription: this is the lapsed case.
  const { text } = await runStatus({ userId });

  assert.match(text, new RegExp(`Groups: ${FREE_LIMITS.maxGroups} of ${FREE_LIMITS.maxGroups}`));
  assert.match(text, /🔒 2 kept but not active/, 'the two beyond the allowance are shown as locked, not dropped');
  assert.match(text, new RegExp(`Keywords: ${FREE_LIMITS.maxKeywords} of ${FREE_LIMITS.maxKeywords}`));
});

test('the Subscribe button appears at the wall, and not before it', async () => {
  const comfortable = 403;
  db.getOrCreateUser({ id: comfortable, username: 'comfy', firstName: 'C' });
  const first = await runStatus({ userId: comfortable });
  assert.equal(first.extra.reply_markup, undefined, 'nobody is pitched for merely checking their status');

  // One summary short of the daily limit is exactly when premium is worth
  // mentioning.
  for (let i = 0; i < FREE_LIMITS.maxSummariesPerDay - 1; i++) db.incrementSummaryUsage(comfortable);
  const atWall = await runStatus({ userId: comfortable });
  assert.ok(atWall.extra.reply_markup, 'a user at the edge of the free plan gets the button');
  assert.equal(atWall.extra.reply_markup.inline_keyboard[0][0].callback_data, 'renew:open');

  // A subscriber is never pitched, however much they have used.
  const paid = 404;
  db.getOrCreateUser({ id: paid, username: 'paid2', firstName: 'P' });
  const subscription = activeSubscription(paid);
  for (let i = 0; i < 10; i++) db.incrementSummaryUsage(paid);
  const premium = await runStatus({ userId: paid, subscription });
  assert.equal(premium.extra.reply_markup, undefined);
});

test('a digest the bot switched off says so, so the state is not a mystery', async () => {
  const userId = 405;
  db.getOrCreateUser({ id: userId, username: 'blocked', firstName: 'B' });
  db.getOrCreateChat({ id: -405, title: 'Blocked Group', type: 'group' });
  db.linkUserToChat(-405, userId);
  db.setScheduledDigest({ chatId: -405, userId, hourUtc: 9 });

  const on = await runStatus({ userId });
  assert.match(on.text, /09:00 UTC/);

  db.disableScheduledDigest(-405, userId, 'blocked');
  const blocked = await runStatus({ userId });
  assert.match(blocked.text, /because you blocked me/);

  // Turning it back on clears the reason, rather than leaving a stale
  // explanation attached to a working digest.
  db.setScheduledDigest({ chatId: -405, userId, hourUtc: 9 });
  const back = await runStatus({ userId });
  assert.doesNotMatch(back.text, /because you blocked me/);

  // A digest the user turned off themselves reads as plainly off.
  db.disableScheduledDigest(-405, userId);
  const off = await runStatus({ userId });
  assert.doesNotMatch(off.text, /because you blocked me/);
  assert.match(off.text, /— off/);
});

test('status refuses to print one member of a group their allowances in front of everyone', async () => {
  const userId = 406;
  db.getOrCreateUser({ id: userId, username: 'grouped', firstName: 'G' });

  const { text } = await runStatus({ userId, chat: { id: -406, type: 'supergroup' } });
  assert.equal(text, t('en', 'status.dmOnly'));
});

test('every status string is sendable in every language', () => {
  // Same constraint as the guide and the privacy policy: it goes out with
  // parse_mode Markdown, so an odd marker means it is never delivered at all.
  for (const lang of SUPPORTED_LANGUAGES) {
    for (const key of Object.keys(require('../src/locales/en').status)) {
      const value = t(lang, `status.${key}`);
      assert.notEqual(value, `status.${key}`, `no ${lang} copy for status.${key}`);
      for (const [name, char] of [['bold', '*'], ['code', '`'], ['italic', '_']]) {
        const count = value.split(char).length - 1;
        assert.equal(count % 2, 0, `unbalanced ${name} marker (${char}) in ${lang} status.${key}`);
      }
    }
  }
});
