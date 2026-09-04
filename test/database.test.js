const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-database-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

const db = require('../src/services/database');

test.after(() => {
  db.db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

test('getOrCreateUser creates once and returns the same row on repeat calls', () => {
  const u1 = db.getOrCreateUser({ id: 1, username: 'a', firstName: 'A' });
  assert.equal(u1.id, 1);
  const u2 = db.getOrCreateUser({ id: 1, username: 'changed', firstName: 'Changed' });
  assert.equal(u2.username, 'a');
});

test('chat linking: linkUserToChat, getUserChats, isUserLinkedToChat', () => {
  db.getOrCreateUser({ id: 2, username: 'b', firstName: 'B' });
  db.getOrCreateChat({ id: -1, title: 'Chat 1', type: 'group' });
  db.linkUserToChat(-1, 2);
  db.linkUserToChat(-1, 2); // idempotent

  assert.equal(db.isUserLinkedToChat(-1, 2), true);
  assert.equal(db.isUserLinkedToChat(-1, 999), false);

  const chats = db.getUserChats(2);
  assert.equal(chats.length, 1);
  assert.equal(chats[0].id, -1);
});

test('deactivateChat removes a chat from getUserChats results', () => {
  db.getOrCreateUser({ id: 3, username: 'c', firstName: 'C' });
  db.getOrCreateChat({ id: -2, title: 'Chat 2', type: 'group' });
  db.linkUserToChat(-2, 3);

  db.deactivateChat(-2);

  assert.equal(db.getUserChats(3).some((c) => c.id === -2), false);
});

test('saveMessage dedupes on (chat_id, message_id)', () => {
  db.getOrCreateUser({ id: 4, username: 'd', firstName: 'D' });
  db.getOrCreateChat({ id: -3, title: 'Chat 3', type: 'group' });

  db.saveMessage({ chatId: -3, messageId: 1, userId: 4, username: 'd', text: 'first' });
  db.saveMessage({ chatId: -3, messageId: 1, userId: 4, username: 'd', text: 'duplicate, should be ignored' });

  const messages = db.getRecentMessages(-3, { hours: 24 });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, 'first');
});

test('getRecentMessages excludes messages outside the lookback window', () => {
  db.getOrCreateUser({ id: 5, username: 'e', firstName: 'E' });
  db.getOrCreateChat({ id: -4, title: 'Chat 4', type: 'group' });

  db.saveMessage({
    chatId: -4,
    messageId: 1,
    userId: 5,
    username: 'e',
    text: 'old',
    createdAt: '2000-01-01T00:00:00.000Z',
  });
  db.saveMessage({ chatId: -4, messageId: 2, userId: 5, username: 'e', text: 'recent' });

  const messages = db.getRecentMessages(-4, { hours: 24 });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, 'recent');
});

test('searchMessages: single-chat and cross-chat variants', () => {
  db.getOrCreateUser({ id: 6, username: 'f', firstName: 'F' });
  db.getOrCreateChat({ id: -5, title: 'Chat 5', type: 'group' });
  db.getOrCreateChat({ id: -6, title: 'Chat 6', type: 'group' });
  db.saveMessage({ chatId: -5, messageId: 1, userId: 6, username: 'f', text: 'deploy the app' });
  db.saveMessage({ chatId: -6, messageId: 1, userId: 6, username: 'f', text: 'unrelated topic' });

  const single = db.searchMessages({ chatId: -5, query: 'deploy' });
  assert.equal(single.length, 1);

  const cross = db.searchMessages({ chatIds: [-5, -6], query: 'topic' });
  assert.equal(cross.length, 1);
  assert.equal(cross[0].chat_title, 'Chat 6');

  assert.equal(db.searchMessages({ chatIds: [], query: 'deploy' }).length, 0);
});

test('user filters round-trip through JSON storage', () => {
  db.getOrCreateUser({ id: 7, username: 'g', firstName: 'G' });
  assert.deepEqual(db.getUserFilters(7), { keywords: [], categories: [] });

  db.setUserFilters(7, { keywords: ['deploy'], categories: ['Tech'] });
  assert.deepEqual(db.getUserFilters(7), { keywords: ['deploy'], categories: ['Tech'] });
});

test('subscriptions: active vs. expired', () => {
  db.getOrCreateUser({ id: 8, username: 'h', firstName: 'H' });
  assert.equal(db.getActiveSubscription(8), undefined);

  db.createSubscription({
    userId: 8,
    plan: 'monthly',
    starsPaid: 150,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  assert.ok(db.getActiveSubscription(8));

  db.getOrCreateUser({ id: 9, username: 'i', firstName: 'I' });
  db.createSubscription({
    userId: 9,
    plan: 'monthly',
    starsPaid: 150,
    expiresAt: new Date(Date.now() - 86400000).toISOString(),
  });
  assert.equal(db.getActiveSubscription(9), undefined);
});

test('daily usage increments per user per date', () => {
  db.getOrCreateUser({ id: 10, username: 'j', firstName: 'J' });
  assert.equal(db.getSummaryUsageToday(10), 0);

  db.incrementSummaryUsage(10);
  db.incrementSummaryUsage(10);

  assert.equal(db.getSummaryUsageToday(10), 2);
});

test('scheduled digests: set, disable, and due lookup', () => {
  db.getOrCreateUser({ id: 11, username: 'k', firstName: 'K' });
  db.getOrCreateChat({ id: -7, title: 'Chat 7', type: 'group' });
  db.linkUserToChat(-7, 11);

  db.setScheduledDigest({ chatId: -7, userId: 11, hourUtc: 9 });
  assert.equal(db.getDueScheduledDigests(9).length, 1);
  assert.equal(db.getDueScheduledDigests(9)[0].chat_id, -7);

  db.disableScheduledDigest(-7, 11);
  assert.equal(db.getDueScheduledDigests(9).length, 0);

  db.setScheduledDigest({ chatId: -7, userId: 11, hourUtc: 18 });
  assert.equal(db.getDueScheduledDigests(9).length, 0);
  assert.equal(db.getDueScheduledDigests(18).length, 1);
});

test('digest cache: roundtrip, fingerprint scoping, and language scoping', () => {
  db.getOrCreateChat({ id: -8, title: 'Chat 8', type: 'group' });

  assert.equal(db.getCachedDigestSummary(-8, 24, 'en', 'fp1'), null);
  db.setCachedDigestSummary(-8, 24, 'en', 'fp1', 'cached summary text');
  assert.equal(db.getCachedDigestSummary(-8, 24, 'en', 'fp1'), 'cached summary text');
  assert.equal(db.getCachedDigestSummary(-8, 24, 'en', 'fp2'), null, 'a different fingerprint must miss');

  // Same chat, window and fingerprint but a different language is a different
  // artifact and must not serve the other language's cached text.
  assert.equal(db.getCachedDigestSummary(-8, 24, 'ru', 'fp1'), null, 'a different language must miss');

  db.setCachedDigestSummary(-8, 24, 'ru', 'fp1', 'кэшированная сводка');
  assert.equal(db.getCachedDigestSummary(-8, 24, 'ru', 'fp1'), 'кэшированная сводка');
  assert.equal(
    db.getCachedDigestSummary(-8, 24, 'en', 'fp1'),
    'cached summary text',
    'storing another language must not clobber the existing one'
  );
});

test('group-count limit helpers: isChatWithinFreeLimit and getAllowedUserChats', () => {
  db.getOrCreateUser({ id: 12, username: 'l', firstName: 'L' });
  db.getOrCreateChat({ id: -9, title: 'Early', type: 'group' });
  db.getOrCreateChat({ id: -10, title: 'Late', type: 'group' });

  db.linkUserToChat(-9, 12);
  db.db
    .prepare('UPDATE chat_members SET joined_at = ? WHERE chat_id = ? AND user_id = ?')
    .run('2020-01-01 00:00:00', -9, 12);
  db.linkUserToChat(-10, 12);
  db.db
    .prepare('UPDATE chat_members SET joined_at = ? WHERE chat_id = ? AND user_id = ?')
    .run('2020-01-02 00:00:00', -10, 12);

  assert.equal(db.isChatWithinFreeLimit(12, -9, 1), true);
  assert.equal(db.isChatWithinFreeLimit(12, -10, 1), false);
  assert.equal(db.isChatWithinFreeLimit(12, -10, Infinity), true);

  const allowed = db.getAllowedUserChats(12, 1);
  assert.equal(allowed.length, 1);
  assert.equal(allowed[0].id, -9);

  assert.equal(db.getAllowedUserChats(12, Infinity).length, 2);
});

test('getRecentMessages returns the NEWEST messages in the window, not the oldest', () => {
  db.getOrCreateUser({ id: 13, username: 'm', firstName: 'M' });
  db.getOrCreateChat({ id: -11, title: 'Busy', type: 'supergroup' });

  // More messages than the cap, all inside the lookback window.
  const now = Date.now();
  for (let i = 0; i < 250; i += 1) {
    db.saveMessage({
      chatId: -11,
      messageId: i,
      userId: 13,
      username: 'm',
      text: `msg ${i}`,
      // Oldest first, so message 249 is the most recent.
      createdAt: new Date(now - (250 - i) * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19),
    });
  }

  const recent = db.getRecentMessages(-11, { hours: 24, limit: 200 });

  assert.equal(recent.length, 200);
  // The bug this guards: taking the oldest 200 meant a busy group was
  // summarized from the start of the window and everything since was dropped.
  assert.equal(recent[recent.length - 1].text, 'msg 249', 'the newest message must be included');
  assert.equal(recent[0].text, 'msg 50', 'the oldest 50 are what falls off the cap');

  // Still oldest-first, so the transcript handed to the model reads in order.
  const times = recent.map((m) => m.created_at);
  assert.deepEqual(times, [...times].sort(), 'results must stay in chronological order');
});
