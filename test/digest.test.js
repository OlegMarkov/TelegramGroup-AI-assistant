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

/**
 * The single most important correctness property in digest.js: the expensive
 * thing is shared, the personal thing never is.
 *
 * generateDigest caches the DeepSeek summary per (chat, hours, language) and
 * hands the same text to everyone, but recomputes the highlight block for each
 * requester from their own /filter settings. Get it wrong in the other
 * direction — cache the whole rendered body, which is an obvious-looking
 * optimization — and one person's private keyword matches appear inside
 * another person's summary of the same chat.
 *
 * The rule is invisible in the shape of the code. A comment says so; this says
 * so in a way that fails the build.
 */
test('the summary is shared across requesters and the highlights never are', async () => {
  db.getOrCreateUser({ id: 101, username: 'alice', firstName: 'Alice' });
  db.getOrCreateUser({ id: 102, username: 'bob', firstName: 'Bob' });
  db.getOrCreateChat({ id: -101, title: 'Team', type: 'group' });
  db.saveMessage({ chatId: -101, messageId: 1, userId: 101, username: 'alice', text: 'the zebra escaped again' });
  db.saveMessage({ chatId: -101, messageId: 2, userId: 101, username: 'alice', text: 'a walrus appeared today' });

  // Two people, same chat, same language, DIFFERENT private keywords.
  db.setUserFilters(101, { keywords: ['zebra'], categories: [] });
  db.setUserFilters(102, { keywords: ['walrus'], categories: [] });

  const before = deepseekCallCount;
  const forAlice = await generateDigest(-101, 101, 24);
  const forBob = await generateDigest(-101, 102, 24);

  assert.equal(deepseekCallCount, before + 1, 'the expensive call is made once and shared');
  assert.equal(forBob.summaryText, forAlice.summaryText, 'and both get the same summary text');

  // Each sees their own matches...
  assert.match(forAlice.highlightBlock, /zebra escaped/);
  assert.match(forBob.highlightBlock, /walrus appeared/);

  // ...and, the direction that actually matters, neither sees the other's.
  assert.doesNotMatch(forAlice.highlightBlock, /walrus/, "Alice must not see Bob's keyword matches");
  assert.doesNotMatch(forBob.highlightBlock, /zebra/, "Bob must not see Alice's keyword matches");
});

test('a lapsed subscriber is gated on the way out, where the gating actually lives', async () => {
  // allowedKeywords is applied in digest.js rather than at the /filter screen,
  // because a subscription can lapse between adding a keyword and running a
  // summary. Moving that check to the screen would silently un-gate everyone
  // who added keywords while subscribed.
  db.getOrCreateUser({ id: 105, username: 'erin', firstName: 'Erin' });
  db.getOrCreateChat({ id: -105, title: 'Lapsed', type: 'group' });
  db.saveMessage({ chatId: -105, messageId: 1, userId: 105, username: 'erin', text: 'the zebra escaped again' });
  db.saveMessage({ chatId: -105, messageId: 2, userId: 105, username: 'erin', text: 'a walrus appeared today' });

  // Three keywords, kept from a subscription that has since lapsed. Free
  // allows one, and "earliest N wins" makes it the first.
  db.setUserFilters(105, { keywords: ['zebra', 'walrus', 'penguin'], categories: [] });
  assert.equal(db.getActiveSubscription(105), undefined, 'this test is only meaningful without a subscription');

  const result = await generateDigest(-105, 105, 24);

  assert.match(result.highlightBlock, /zebra escaped/, 'the keyword within the allowance still matches');
  assert.doesNotMatch(result.highlightBlock, /walrus/, 'the keywords beyond it are stored but not live');
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
