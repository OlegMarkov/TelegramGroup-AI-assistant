const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-captions-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

const deepseek = require('../src/services/deepseek');
let lastTranscript = null;
deepseek.summarize = async (transcript) => {
  lastTranscript = transcript;
  return 'stub summary';
};

const db = require('../src/services/database');
const ingestion = require('../src/middleware/ingestion');
const { generateDigest } = require('../src/services/digest');
const { t, SUPPORTED_LANGUAGES } = require('../src/utils/i18n');

test.after(() => {
  db.db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

const middleware = ingestion();
let nextMessageId = 1;

/** Puts one group update through the real ingestion middleware. */
async function ingest({ chatId, userId = 700, message }) {
  await middleware(
    {
      chat: { id: chatId, title: 'Captions', type: 'group' },
      from: { id: userId, username: `u${userId}`, is_bot: false },
      message: { message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), ...message },
      state: {},
    },
    async () => {}
  );
}

function stored(chatId) {
  return db.db.prepare('SELECT text, is_caption FROM messages WHERE chat_id = ? ORDER BY id').all(chatId);
}

test('a captioned photo is stored; the same photo without a caption is not', async () => {
  db.getOrCreateUser({ id: 700, username: 'u700', firstName: 'U' });

  // A screenshot with an explanation under it — in plenty of real groups this
  // is where the content actually is.
  await ingest({
    chatId: -700,
    message: { photo: [{ file_id: 'abc', width: 800, height: 600 }], caption: 'the staging deploy failed here' },
  });

  // A photo posted with nothing said about it. There is nothing to summarize.
  await ingest({ chatId: -700, message: { photo: [{ file_id: 'def', width: 800, height: 600 }] } });

  // And a sticker, which never carries a caption at all.
  await ingest({ chatId: -700, message: { sticker: { file_id: 'ghi' } } });

  assert.deepEqual(
    stored(-700).map((m) => m.text),
    ['the staging deploy failed here'],
    'only the caption is kept, and only when there is one'
  );
});

test('captions on video, document and voice are treated the same as on a photo', async () => {
  db.getOrCreateUser({ id: 701, username: 'u701', firstName: 'V' });

  await ingest({ chatId: -701, userId: 701, message: { video: { file_id: 'v' }, caption: 'the repro, recorded' } });
  await ingest({ chatId: -701, userId: 701, message: { document: { file_id: 'd' }, caption: 'the log file' } });
  await ingest({ chatId: -701, userId: 701, message: { voice: { file_id: 'a' }, caption: 'quick note' } });

  assert.deepEqual(
    stored(-701).map((m) => m.text),
    ['the repro, recorded', 'the log file', 'quick note'],
    'Telegram puts every caption in the same field, so one check covers them all'
  );
});

test('a caption is flagged as one, and a plain message is not', async () => {
  db.getOrCreateUser({ id: 702, username: 'u702', firstName: 'W' });

  await ingest({ chatId: -702, userId: 702, message: { text: 'just talking' } });
  await ingest({ chatId: -702, userId: 702, message: { photo: [{ file_id: 'x' }], caption: 'look at this' } });

  // Mapped rather than compared directly: node:sqlite hands back null-prototype
  // objects, which strict deepEqual refuses to match against object literals.
  assert.deepEqual(
    stored(-702).map((m) => ({ text: m.text, is_caption: m.is_caption })),
    [
      { text: 'just talking', is_caption: 0 },
      { text: 'look at this', is_caption: 1 },
    ]
  );
});

test('a caption that is a command or a menu label is skipped, in every language', async () => {
  // A caption cannot really be either of these, but the exclusions are applied
  // uniformly rather than branching on where the text came from — so if that
  // ever stops being true, nothing leaks through.
  db.getOrCreateUser({ id: 703, username: 'u703', firstName: 'X' });

  await ingest({ chatId: -703, userId: 703, message: { photo: [{ file_id: 'p' }], caption: '/summary 12' } });

  for (const lang of SUPPORTED_LANGUAGES) {
    await ingest({
      chatId: -703,
      userId: 703,
      message: { photo: [{ file_id: 'p' }], caption: t(lang, 'menu.summary') },
    });
  }

  assert.deepEqual(stored(-703), [], 'none of those are things a person said to the group');
});

test('the transcript marks a caption, so the model knows it describes an image', async () => {
  db.getOrCreateUser({ id: 704, username: 'photographer', firstName: 'P' });

  await ingest({ chatId: -704, userId: 704, message: { text: 'anyone seen the build?' } });
  await ingest({
    chatId: -704,
    userId: 704,
    message: { photo: [{ file_id: 'q' }], caption: 'it is red, see' },
  });

  await generateDigest(-704, 704, 24);

  // The transcript names the author from ctx.from.username, which ingest()
  // sets to u<id> — the users-table row is not what reaches the model.
  assert.match(lastTranscript, /u704: anyone seen the build\?/, 'a plain message is unmarked');
  assert.match(lastTranscript, /u704: \[media\] it is red, see/, 'a caption is marked');
});

test('the caption marker stays out of the stored text, and out of highlights', async () => {
  // It belongs in the AI transcript only. Stored in the text it would show up
  // in /find results and filter highlights as though the user had typed it.
  db.getOrCreateUser({ id: 705, username: 'u705', firstName: 'Y' });
  db.setUserFilters(705, { keywords: ['zebra'], categories: [] });

  await ingest({ chatId: -705, userId: 705, message: { photo: [{ file_id: 'z' }], caption: 'a zebra, somehow' } });

  const [row] = stored(-705);
  assert.equal(row.text, 'a zebra, somehow', 'no marker in the database');

  assert.deepEqual(
    db.searchMessages({ chatId: -705, query: 'zebra' }).map((m) => m.text),
    ['a zebra, somehow'],
    'and none in search results'
  );

  const result = await generateDigest(-705, 705, 24);
  assert.match(result.highlightBlock, /a zebra, somehow/);
  assert.doesNotMatch(result.highlightBlock, /\[media\]/, 'and none in the highlight the user reads');
});

test('the privacy copy no longer claims non-text content is ignored entirely', () => {
  // This change increases how much of other people's content is retained, so
  // the policy has to describe it. A test rather than a note, because the copy
  // and the behaviour drifting apart is the actual risk.
  for (const lang of SUPPORTED_LANGUAGES) {
    const policy = t(lang, 'privacy.policy', { retentionDays: 90, purgeDays: 7, groupChars: 300 });
    const mentionsCaptions = /caption|подпис/i.test(policy);
    assert.ok(mentionsCaptions, `the ${lang} privacy copy must say captions are stored`);
  }
});
