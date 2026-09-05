const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-timezone-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

const {
  OFFSET_CHOICES,
  isValidOffset,
  formatOffset,
  formatLocalTime,
  localTimeAt,
  utcHourForLocalHour,
  hoursInLocalOrder,
} = require('../src/utils/timezone');

const db = require('../src/services/database');
const registerDigest = require('../src/commands/digest');

const handlers = { commands: {}, actions: [] };
registerDigest({
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

function makeCtx({ userId, chatId, lang = 'en' }) {
  const replies = [];
  const answers = [];
  return {
    chat: { id: userId, type: 'private' },
    from: { id: userId },
    message: { text: '/digest' },
    state: { lang, subscription: { plan: 'monthly' } },
    replies,
    answers,
    reply: async (text, extra) => {
      replies.push({ text, extra: extra || {} });
      return { message_id: 1 };
    },
    editMessageText: async (text) => {
      replies.push({ text, extra: {} });
    },
    answerCbQuery: async (text) => {
      answers.push(text || '');
    },
  };
}

async function fire(callbackData, ctx) {
  for (const { pattern, fn } of handlers.actions) {
    const match = pattern.exec(callbackData);
    if (match) {
      ctx.match = match;
      await fn(ctx);
      return true;
    }
  }
  return false;
}

function buttonsOf(reply) {
  return reply.extra.reply_markup.inline_keyboard.flat();
}

// --- the conversion itself -------------------------------------------------

test('a local hour maps to the right UTC hour, including across midnight', () => {
  // Whole-hour offsets, both directions.
  assert.equal(utcHourForLocalHour(12, 180), 9, 'noon in UTC+3 is 09:00 UTC');
  assert.equal(utcHourForLocalHour(12, -300), 17, 'noon in UTC-5 is 17:00 UTC');
  assert.equal(utcHourForLocalHour(9, 0), 9, 'UTC is the identity');

  // Wrapping backwards past midnight: 01:00 in UTC+3 is 22:00 the day before.
  assert.equal(utcHourForLocalHour(1, 180), 22);
  // And forwards: 22:00 in UTC-5 is 03:00 the next day.
  assert.equal(utcHourForLocalHour(22, -300), 3);

  // The extremes of the offered range.
  assert.equal(utcHourForLocalHour(0, 720), 12);
  assert.equal(utcHourForLocalHour(0, -480), 8);
});

test('the two directions are inverses at every whole-hour offset', () => {
  for (const offset of OFFSET_CHOICES.filter((o) => o % 60 === 0)) {
    for (let hourUtc = 0; hourUtc < 24; hourUtc++) {
      const local = localTimeAt(hourUtc, offset);
      assert.equal(local.minute, 0);
      assert.equal(
        utcHourForLocalHour(local.hour, offset),
        hourUtc,
        `round trip failed at ${hourUtc} UTC, offset ${offset}`
      );
    }
  }
});

test('a half-hour offset is shown honestly rather than rounded into a lie', () => {
  // At UTC+05:30 the times the hourly tick can actually deliver are :30 past.
  // Offering "09:00" would promise a delivery time that cannot happen.
  assert.equal(formatLocalTime(3, 330), '08:30');
  assert.equal(formatLocalTime(4, 330), '09:30');

  const labels = hoursInLocalOrder(330).map((h) => h.label);
  assert.equal(labels.length, 24);
  assert.ok(labels.every((l) => l.endsWith(':30')), 'every option at +05:30 lands on the half hour');
  assert.equal(labels[0], '00:30', 'and the list reads in the user own clock order');
  assert.equal(labels[23], '23:30');
});

test('the hour list is ordered by the local clock, not by UTC', () => {
  const hours = hoursInLocalOrder(180); // UTC+3
  assert.deepEqual(
    hours.slice(0, 3).map((h) => h.label),
    ['00:00', '01:00', '02:00']
  );
  // 00:00 local at UTC+3 is 21:00 UTC the day before.
  assert.equal(hours[0].hourUtc, 21);
});

test('offsets render the way people write them', () => {
  assert.equal(formatOffset(0), 'UTC');
  assert.equal(formatOffset(180), 'UTC+03:00');
  assert.equal(formatOffset(330), 'UTC+05:30');
  assert.equal(formatOffset(-300), 'UTC−05:00');
});

test('only offsets we actually offer are accepted', () => {
  // The keyboard is ours; the callback data is whatever arrives.
  assert.equal(isValidOffset(180), true);
  assert.equal(isValidOffset(999), false);
  assert.equal(isValidOffset(1.5), false);
  assert.equal(isValidOffset(null), false);
});

// --- what it changes, and what it must not ---------------------------------

test('an unset timezone still offers exactly the four UTC hours it always did', async () => {
  const userId = 1000;
  const chatId = -1000;
  db.getOrCreateUser({ id: userId, username: 'nozone', firstName: 'N' });
  db.getOrCreateChat({ id: chatId, title: 'Group', type: 'group' });
  db.linkUserToChat(chatId, userId);

  assert.equal(db.getUserTimezoneOffset(userId), null);

  const ctx = makeCtx({ userId, chatId });
  await handlers.commands.digest(ctx);

  const labels = buttonsOf(ctx.replies[0]).map((b) => b.text);
  assert.deepEqual(
    labels.filter((l) => l.includes('UTC') && l.includes(':')),
    ['09:00 UTC', '12:00 UTC', '18:00 UTC', '21:00 UTC'],
    'the flow is not blocked and nothing about it changed'
  );
  assert.ok(
    labels.some((l) => /timezone/i.test(l)),
    'the offer to fix that sits beside the times rather than in front of them'
  );
});

test('once a timezone is known, all 24 hours are offered in local time', async () => {
  const userId = 1001;
  const chatId = -1001;
  db.getOrCreateUser({ id: userId, username: 'moscow', firstName: 'M' });
  db.getOrCreateChat({ id: chatId, title: 'Group', type: 'group' });
  db.linkUserToChat(chatId, userId);

  const tzCtx = makeCtx({ userId, chatId });
  assert.ok(await fire(`digest:tz:${chatId}:180`, tzCtx), 'the timezone callback is registered');
  assert.equal(db.getUserTimezoneOffset(userId), 180);

  const hourButtons = buttonsOf(tzCtx.replies[tzCtx.replies.length - 1]).filter((b) =>
    /^digest:set:/.test(b.callback_data)
  );
  assert.equal(hourButtons.length, 24);
  assert.equal(hourButtons[0].text, '00:00');
  assert.equal(hourButtons[0].callback_data, `digest:set:${chatId}:21`, '00:00 in UTC+3 is 21:00 UTC');
});

test('what gets STORED is the UTC hour, whatever the button said', async () => {
  // The load-bearing property. The scheduler matches scheduled_digests.hour_utc
  // against the current UTC hour, so a timezone that leaked into that column
  // would deliver every digest at the wrong time.
  const userId = 1002;
  const chatId = -1002;
  db.getOrCreateUser({ id: userId, username: 'stored', firstName: 'S' });
  db.getOrCreateChat({ id: chatId, title: 'Group', type: 'group' });
  db.linkUserToChat(chatId, userId);
  db.setUserTimezoneOffset(userId, 180);

  const ctx = makeCtx({ userId, chatId });
  // The button labelled 09:00 local, which is 06:00 UTC.
  await fire(`digest:set:${chatId}:6`, ctx);

  const row = db.getScheduledDigest(chatId, userId);
  assert.equal(row.hour_utc, 6, 'the stored value is UTC and nothing else');

  // And the tick finds it at the UTC hour, not the local one.
  assert.ok(db.getDueScheduledDigests(6).some((d) => d.user_id === userId));
  assert.ok(!db.getDueScheduledDigests(9).some((d) => d.user_id === userId));

  assert.match(ctx.replies[ctx.replies.length - 1].text, /09:00 \(06:00 UTC\)/, 'and the confirmation says both');
});

test('changing timezone relabels an existing digest without moving it', async () => {
  const userId = 1003;
  const chatId = -1003;
  db.getOrCreateUser({ id: userId, username: 'mover', firstName: 'M' });
  db.getOrCreateChat({ id: chatId, title: 'Group', type: 'group' });
  db.linkUserToChat(chatId, userId);
  db.setScheduledDigest({ chatId, userId, hourUtc: 6 });

  const ctx = makeCtx({ userId, chatId });
  await fire(`digest:tz:${chatId}:180`, ctx);

  assert.equal(db.getScheduledDigest(chatId, userId).hour_utc, 6, 'the same moment, still');
  assert.match(
    ctx.replies[ctx.replies.length - 1].text,
    /09:00 \(06:00 UTC\)/,
    'described in their clock now, but unmoved'
  );
});

test('a timezone we do not offer is refused rather than stored', async () => {
  const userId = 1004;
  const chatId = -1004;
  db.getOrCreateUser({ id: userId, username: 'forger', firstName: 'F' });
  db.getOrCreateChat({ id: chatId, title: 'Group', type: 'group' });
  db.linkUserToChat(chatId, userId);

  const ctx = makeCtx({ userId, chatId });
  await fire(`digest:tz:${chatId}:999`, ctx);

  assert.equal(db.getUserTimezoneOffset(userId), null);
});

test('a timezone cannot be set for a chat the user is not in', async () => {
  const userId = 1005;
  db.getOrCreateUser({ id: userId, username: 'outsider', firstName: 'O' });
  db.getOrCreateChat({ id: -1006, title: 'Not theirs', type: 'group' });

  const ctx = makeCtx({ userId, chatId: -1006 });
  await fire('digest:tz:-1006:180', ctx);

  assert.equal(db.getUserTimezoneOffset(userId), null);
  assert.match(ctx.answers[0], /Not authorized/i);
});
