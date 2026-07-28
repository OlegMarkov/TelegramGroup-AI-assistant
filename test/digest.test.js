const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-digest-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

// Stub the DeepSeek call before digest.js (which requires it) is loaded.
const deepseek = require('../src/services/deepseek');
let deepseekCallCount = 0;
deepseek.summarize = async () => {
  deepseekCallCount += 1;
  return `stub-summary-${deepseekCallCount}`;
};

const db = require('../src/services/database');
const { generateDigest } = require('../src/services/digest');

test.after(() => {
  db.db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

test('generateDigest returns null when there is no activity', async () => {
  db.getOrCreateUser({ id: 100, username: 'u', firstName: 'U' });
  db.getOrCreateChat({ id: -100, title: 'Empty', type: 'group' });

  const result = await generateDigest(-100, 100, 24);
  assert.equal(result, null);
});

test('generateDigest caches the DeepSeek call across requesters, but recomputes highlights per user', async () => {
  db.getOrCreateUser({ id: 101, username: 'alice', firstName: 'Alice' });
  db.getOrCreateUser({ id: 102, username: 'bob', firstName: 'Bob' });
  db.getOrCreateChat({ id: -101, title: 'Team', type: 'group' });
  db.saveMessage({ chatId: -101, messageId: 1, userId: 101, username: 'alice', text: 'deploy at 3pm' });
  db.setUserFilters(102, { keywords: ['deploy'], categories: [] });

  const before = deepseekCallCount;
  const r1 = await generateDigest(-101, 101, 24);
  assert.equal(deepseekCallCount, before + 1);
  assert.equal(r1.highlightBlock, '');

  const r2 = await generateDigest(-101, 102, 24);
  assert.equal(deepseekCallCount, before + 1, 'second requester should hit the cache, not call DeepSeek again');
  assert.equal(r2.summaryText, r1.summaryText);
  assert.match(r2.highlightBlock, /deploy at 3pm/);
});

test('generateDigest invalidates the cache when a new message arrives', async () => {
  db.getOrCreateUser({ id: 103, username: 'carol', firstName: 'Carol' });
  db.getOrCreateChat({ id: -102, title: 'Team2', type: 'group' });
  db.saveMessage({ chatId: -102, messageId: 1, userId: 103, username: 'carol', text: 'first message' });

  const r1 = await generateDigest(-102, 103, 24);
  const before = deepseekCallCount;

  db.saveMessage({ chatId: -102, messageId: 2, userId: 103, username: 'carol', text: 'second message' });
  const r2 = await generateDigest(-102, 103, 24);

  assert.equal(deepseekCallCount, before + 1, 'a new message should invalidate the cache');
  assert.notEqual(r2.summaryText, r1.summaryText);
});

test('generateDigest treats different lookback windows as separate cache entries', async () => {
  db.getOrCreateUser({ id: 104, username: 'dave', firstName: 'Dave' });
  db.getOrCreateChat({ id: -103, title: 'Team3', type: 'group' });
  db.saveMessage({ chatId: -103, messageId: 1, userId: 104, username: 'dave', text: 'only message' });

  const before = deepseekCallCount;
  await generateDigest(-103, 104, 24);
  await generateDigest(-103, 104, 48);

  assert.equal(deepseekCallCount, before + 2, 'a different hours value must not reuse another window\'s cache entry');
});
