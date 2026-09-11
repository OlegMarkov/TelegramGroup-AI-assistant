const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-privacy-${crypto.randomUUID()}.db`);
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

test('purgeExpiredMessages deletes messages past the retention window and keeps recent ones', () => {
  db.getOrCreateUser({ id: 600, username: 'a', firstName: 'A' });
  db.getOrCreateChat({ id: -600, title: 'Retention', type: 'group' });

  db.saveMessage({
    chatId: -600,
    messageId: 1,
    userId: 600,
    username: 'a',
    text: 'ancient',
    createdAt: '2000-01-01T00:00:00.000Z',
  });
  db.saveMessage({ chatId: -600, messageId: 2, userId: 600, username: 'a', text: 'fresh' });

  const deleted = db.purgeExpiredMessages(90);
  assert.equal(deleted, 1);

  const remaining = db.db.prepare('SELECT text FROM messages WHERE chat_id = -600').all();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].text, 'fresh');
});

test('purgeRemovedChatData respects the grace period, then purges and clears the marker', () => {
  db.getOrCreateUser({ id: 601, username: 'b', firstName: 'B' });
  db.getOrCreateChat({ id: -601, title: 'Removed', type: 'group' });
  db.saveMessage({ chatId: -601, messageId: 1, userId: 601, username: 'b', text: 'hello' });
  db.setCachedDigestSummary(-601, 24, 'en', 'fp', 'cached text');

  db.deactivateChat(-601);

  // Just deactivated — still inside the 7-day grace period.
  let result = db.purgeRemovedChatData(7);
  assert.equal(result.messages, 0, 'must not purge during the grace period');
  assert.equal(db.db.prepare('SELECT COUNT(*) c FROM messages WHERE chat_id = -601').get().c, 1);

  // Backdate the removal to simulate the grace period elapsing.
  db.db.prepare("UPDATE chats SET deactivated_at = '2000-01-01 00:00:00' WHERE id = -601").run();

  result = db.purgeRemovedChatData(7);
  assert.equal(result.chats, 1);
  assert.equal(result.messages, 1);
  assert.equal(db.db.prepare('SELECT COUNT(*) c FROM messages WHERE chat_id = -601').get().c, 0);
  assert.equal(
    db.db.prepare('SELECT COUNT(*) c FROM digest_cache WHERE chat_id = -601').get().c,
    0,
    'cached summaries derived from purged messages must go too'
  );

  // Marker cleared, so a second sweep finds nothing to do.
  assert.equal(db.purgeRemovedChatData(7).chats, 0);
});

test('re-adding the bot to a group before the grace period ends cancels the pending purge', () => {
  db.getOrCreateChat({ id: -602, title: 'Rejoin', type: 'group' });
  db.deactivateChat(-602);
  assert.ok(db.db.prepare('SELECT deactivated_at FROM chats WHERE id = -602').get().deactivated_at);

  db.getOrCreateChat({ id: -602, title: 'Rejoin', type: 'group' });

  const row = db.db.prepare('SELECT is_active, deactivated_at FROM chats WHERE id = -602').get();
  assert.equal(row.is_active, 1);
  assert.equal(row.deactivated_at, null);
});

test('deleteUserData removes personal data, keeps the subscription, and anonymizes events', () => {
  db.getOrCreateUser({ id: 603, username: 'c', firstName: 'C' });
  db.getOrCreateChat({ id: -603, title: 'Forget', type: 'group' });
  db.linkUserToChat(-603, 603);
  db.saveMessage({ chatId: -603, messageId: 1, userId: 603, username: 'c', text: 'my message' });
  db.setUserFilters(603, { keywords: ['x'], categories: [] });
  db.setScheduledDigest({ chatId: -603, userId: 603, hourUtc: 9 });
  db.incrementSummaryUsage(603);
  db.recordSummaryRead(603, -603);
  db.logEvent('summary_requested', { userId: 603, chatId: -603 });
  db.createSubscription({
    userId: 603,
    plan: 'monthly',
    starsPaid: 150,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  });
  db.setCachedDigestSummary(-603, 24, 'en', 'fp', 'summary built from my message');

  const summary = db.getUserDataSummary(603);
  assert.equal(summary.messageCount, 1);
  assert.equal(summary.chatCount, 1);

  const result = db.deleteUserData(603);
  assert.equal(result.messagesDeleted, 1);
  assert.equal(result.chatsAffected, 1);

  assert.equal(db.db.prepare('SELECT COUNT(*) c FROM messages WHERE user_id = 603').get().c, 0);
  assert.deepEqual(db.getUserFilters(603), { keywords: [], categories: [] });
  assert.equal(db.db.prepare('SELECT COUNT(*) c FROM chat_members WHERE user_id = 603').get().c, 0);
  assert.equal(db.db.prepare('SELECT COUNT(*) c FROM scheduled_digests WHERE user_id = 603').get().c, 0);
  assert.equal(db.getSummaryUsageToday(603), 0);
  assert.equal(
    db.db.prepare('SELECT COUNT(*) c FROM summary_reads WHERE user_id = 603').get().c,
    0,
    'when they last read a summary is a usage counter, and goes with the rest of them'
  );

  assert.equal(
    db.db.prepare('SELECT COUNT(*) c FROM digest_cache WHERE chat_id = -603').get().c,
    0,
    'cached summaries containing the deleted text must be invalidated'
  );

  // Payment record survives so billing history/refunds remain possible.
  assert.ok(db.getActiveSubscription(603), 'subscription must survive a data deletion request');

  // Event row kept for aggregate analytics, but no longer linked to the user.
  const events = db.db.prepare("SELECT user_id FROM events WHERE event_type = 'summary_requested'").all();
  assert.ok(events.length > 0);
  assert.ok(
    events.every((e) => e.user_id !== 603),
    'events must be anonymized rather than left pointing at the deleted user'
  );
});
