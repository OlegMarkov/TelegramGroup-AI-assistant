const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-feedback-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

const db = require('../src/services/database');
const registerFeedback = require('../src/commands/feedback');
const { feedbackKeyboard } = require('../src/commands/feedback');
const { t } = require('../src/utils/i18n');

const actions = [];
registerFeedback({
  command() {},
  hears() {},
  action(pattern, fn) {
    actions.push({ pattern, fn });
  },
});

test.after(() => {
  db.db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

function makeCtx({ userId, messageId = 500, lang = 'en' }) {
  const answers = [];
  return {
    from: { id: userId },
    chat: { id: userId, type: 'private' },
    state: { lang },
    answers,
    callbackQuery: { message: { message_id: messageId } },
    answerCbQuery: async (msg) => {
      answers.push(msg || '');
    },
  };
}

async function tap(callbackData, ctx) {
  for (const { pattern, fn } of actions) {
    const match = pattern.exec(callbackData);
    if (match) {
      ctx.match = match;
      await fn(ctx);
      return true;
    }
  }
  return false;
}

function votes() {
  return db.db.prepare('SELECT * FROM summary_feedback ORDER BY user_id, message_id').all();
}

test('the keyboard fits inside Telegram callback_data limit', () => {
  // 64 bytes is a hard cap, and the worst case is a supergroup id with a
  // week-long lookback.
  const keyboard = feedbackKeyboard('ru', { chatId: -1001234567890, hours: 168 });
  for (const button of keyboard.reply_markup.inline_keyboard[0]) {
    assert.ok(
      Buffer.byteLength(button.callback_data, 'utf8') <= 64,
      `${button.callback_data} is ${Buffer.byteLength(button.callback_data, 'utf8')} bytes`
    );
  }

  // Never the summary text — identifiers only.
  assert.match(keyboard.reply_markup.inline_keyboard[0][0].callback_data, /^fb:u:-1001234567890:168:ru$/);
});

test('a tap records exactly one vote, with the chat, hours and language', async () => {
  db.getOrCreateUser({ id: 600, username: 'rater', firstName: 'R' });

  const ctx = makeCtx({ userId: 600 });
  assert.ok(await tap('fb:u:-1009999:24:en', ctx), 'the callback is registered');

  const rows = votes();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, 600);
  assert.equal(rows[0].chat_id, -1009999, 'the chat SUMMARIZED, not the chat replied in');
  assert.equal(rows[0].vote, 1);
  assert.equal(rows[0].hours, 24);
  assert.equal(rows[0].language, 'en');
  assert.equal(ctx.answers[0], t('en', 'feedback.thanksUp'));
});

test('tapping again changes your mind rather than counting twice', async () => {
  db.getOrCreateUser({ id: 601, username: 'changer', firstName: 'C' });

  await tap('fb:u:-1008888:24:en', makeCtx({ userId: 601, messageId: 700 }));
  await tap('fb:d:-1008888:24:en', makeCtx({ userId: 601, messageId: 700 }));
  await tap('fb:d:-1008888:24:en', makeCtx({ userId: 601, messageId: 700 }));

  const rows = votes().filter((r) => r.user_id === 601);
  assert.equal(rows.length, 1, 'one person, one delivered summary, one vote');
  assert.equal(rows[0].vote, -1, 'and the latest tap is the one that stands');
});

test('everyone in a group gets their own vote on the same shared summary', async () => {
  // The buttons sit on one message that the whole group can see, so the vote
  // is keyed on the person as well as the message.
  db.getOrCreateUser({ id: 602, firstName: 'A' });
  db.getOrCreateUser({ id: 603, firstName: 'B' });

  await tap('fb:u:-1007777:24:en', makeCtx({ userId: 602, messageId: 800 }));
  await tap('fb:d:-1007777:24:en', makeCtx({ userId: 603, messageId: 800 }));

  const rows = votes().filter((r) => r.message_id === 800);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.vote).sort(),
    [-1, 1]
  );
});

test('voting still works after the cached summary it was about is gone', async () => {
  // The vote is keyed on the delivered message, never on the cache entry, so
  // invalidation cannot make an old summary unratable or throw.
  db.getOrCreateUser({ id: 604, firstName: 'D' });
  db.getOrCreateChat({ id: -1006666, title: 'Gone', type: 'group' });
  db.setCachedDigestSummary(-1006666, 24, 'en', 'fp1', 'a summary');

  db.db.prepare('DELETE FROM digest_cache WHERE chat_id = ?').run(-1006666);

  const ctx = makeCtx({ userId: 604, messageId: 900 });
  await tap('fb:u:-1006666:24:en', ctx);

  assert.equal(votes().filter((r) => r.user_id === 604).length, 1);
  assert.equal(ctx.answers.length, 1, 'acknowledged rather than left spinning');
});

test('a failed write is acknowledged rather than shown as an error', async () => {
  // A vote is worth less than the summary it is about.
  const ctx = makeCtx({ userId: 999999, messageId: 1000 }); // no users row: foreign key fails

  await tap('fb:u:-1005555:24:en', ctx);

  assert.equal(ctx.answers.length, 1, 'the tap is still answered');
  assert.equal(ctx.answers[0], '', 'quietly, with no thanks it did not earn');
});

test('counts are grouped by language, which is what makes a prompt change comparable', () => {
  db.db.prepare('DELETE FROM summary_feedback').run();
  db.getOrCreateUser({ id: 610, firstName: 'E' });
  db.getOrCreateUser({ id: 611, firstName: 'F' });

  const vote = (userId, messageId, v, language) =>
    db.recordSummaryFeedback({ userId, chatId: -1, messageId, vote: v, hours: 24, language });

  vote(610, 1, 1, 'en');
  vote(611, 1, 1, 'en');
  vote(610, 2, -1, 'en');
  vote(611, 2, 1, 'ru');

  const counts = db.getSummaryFeedbackCounts(30);
  const byLanguage = Object.fromEntries(counts.map((c) => [c.language, { up: c.up, down: c.down }]));

  assert.deepEqual(byLanguage.en, { up: 2, down: 1 });
  assert.deepEqual(byLanguage.ru, { up: 1, down: 0 });
});

test('old votes fall outside the reporting window', () => {
  db.db.prepare('DELETE FROM summary_feedback').run();
  db.getOrCreateUser({ id: 612, firstName: 'G' });
  db.recordSummaryFeedback({ userId: 612, chatId: -1, messageId: 1, vote: 1, hours: 24, language: 'en' });
  db.db.prepare("UPDATE summary_feedback SET created_at = datetime('now', '-60 days')").run();

  assert.deepEqual(db.getSummaryFeedbackCounts(30), [], 'a prompt change is judged against recent votes');
  assert.equal(db.getSummaryFeedbackCounts(90).length, 1);
});
