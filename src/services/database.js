const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');
const logger = require('../utils/logger');

const dbPath = path.resolve(config.database.path);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

function tableColumns(table) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
}

// Pre-schema migration: must run before CREATE TABLE IF NOT EXISTS below.
// digest_cache used to be keyed by (chat_id, hours). Summaries are now
// generated in the requester's language, so two users with different
// languages would otherwise collide on one row and overwrite each other.
// It holds nothing but regenerable cache entries, so rebuilding is safe.
const digestCacheColumns = tableColumns('digest_cache');
if (digestCacheColumns.length > 0 && !digestCacheColumns.includes('language')) {
  db.exec('DROP TABLE digest_cache');
  logger.info('Migration: rebuilt digest_cache to key summaries by language');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_filters (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    keywords TEXT NOT NULL DEFAULT '[]',
    categories TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plan TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    stars_paid INTEGER NOT NULL DEFAULT 0,
    telegram_charge_id TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT
  );

  CREATE TABLE IF NOT EXISTS chats (
    id INTEGER PRIMARY KEY,
    title TEXT,
    type TEXT NOT NULL,
    added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS chat_members (
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (chat_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL,
    user_id INTEGER,
    username TEXT,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (chat_id, message_id)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_chat_created ON messages(chat_id, created_at);

  CREATE TABLE IF NOT EXISTS daily_usage (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    summary_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, date)
  );

  CREATE TABLE IF NOT EXISTS scheduled_digests (
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    hour_utc INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (chat_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_scheduled_digests_due ON scheduled_digests(enabled, hour_utc);

  CREATE TABLE IF NOT EXISTS digest_cache (
    chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    hours INTEGER NOT NULL,
    language TEXT NOT NULL DEFAULT 'en',
    fingerprint TEXT NOT NULL,
    summary_text TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (chat_id, hours, language)
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    chat_id INTEGER,
    event_type TEXT NOT NULL,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(event_type, created_at);
  CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id);
`);

// CREATE TABLE IF NOT EXISTS silently does nothing on a database that already
// has the table, so columns added after the first release need an explicit
// migration or they'll be missing on every existing deployment.
function addColumnIfMissing(table, column, definition) {
  if (tableColumns(table).includes(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  logger.info(`Migration: added ${table}.${column}`);
}

addColumnIfMissing('chats', 'deactivated_at', 'TEXT');
addColumnIfMissing('users', 'language', 'TEXT');

logger.info(`SQLite database ready at ${dbPath}`);

function getOrCreateUser({ id, username, firstName, language }) {
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (existing) return existing;

  db.prepare('INSERT INTO users (id, username, first_name, language) VALUES (?, ?, ?, ?)').run(
    id,
    username || null,
    firstName || null,
    language || null
  );
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getUserFilters(userId) {
  const row = db.prepare('SELECT * FROM user_filters WHERE user_id = ?').get(userId);
  if (!row) return { keywords: [], categories: [] };
  return {
    keywords: JSON.parse(row.keywords),
    categories: JSON.parse(row.categories),
  };
}

function setUserFilters(userId, { keywords = [], categories = [] }) {
  db.prepare(
    `INSERT INTO user_filters (user_id, keywords, categories, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       keywords = excluded.keywords,
       categories = excluded.categories,
       updated_at = excluded.updated_at`
  ).run(userId, JSON.stringify(keywords), JSON.stringify(categories));
}

function getOrCreateChat({ id, title, type, addedBy }) {
  const existing = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);

  if (existing) {
    if (title && title !== existing.title) {
      db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(title, id);
    }
    if (!existing.is_active) {
      // Re-added within the grace period: cancel the pending purge.
      db.prepare('UPDATE chats SET is_active = 1, deactivated_at = NULL WHERE id = ?').run(id);
    }
    return db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  }

  db.prepare('INSERT INTO chats (id, title, type, added_by) VALUES (?, ?, ?, ?)').run(
    id,
    title || null,
    type,
    addedBy || null
  );
  return db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
}

function deactivateChat(chatId) {
  db.prepare(`UPDATE chats SET is_active = 0, deactivated_at = datetime('now') WHERE id = ?`).run(chatId);
}

function linkUserToChat(chatId, userId) {
  const result = db
    .prepare(
      `INSERT INTO chat_members (chat_id, user_id) VALUES (?, ?)
       ON CONFLICT(chat_id, user_id) DO NOTHING`
    )
    .run(chatId, userId);
  return result.changes > 0;
}

function getUserChats(userId) {
  return db
    .prepare(
      `SELECT c.* FROM chats c
       JOIN chat_members cm ON cm.chat_id = c.id
       WHERE cm.user_id = ? AND c.is_active = 1
       ORDER BY c.title`
    )
    .all(userId);
}

// Message ingestion links every user who chats in a tracked group regardless
// of their plan — the group may belong to other, possibly premium, members
// and shouldn't lose tracking because one member happens to be on the free
// plan. The group-count limit instead caps which of a user's linked chats
// they can personally run commands in: their earliest N by join time.
function isChatWithinFreeLimit(userId, chatId, maxGroups) {
  if (!Number.isFinite(maxGroups)) return true;
  const row = db
    .prepare(
      `SELECT 1 FROM (
         SELECT chat_id FROM chat_members WHERE user_id = ? ORDER BY joined_at ASC LIMIT ?
       ) WHERE chat_id = ?`
    )
    .get(userId, maxGroups, chatId);
  return Boolean(row);
}

function getAllowedUserChats(userId, maxGroups) {
  if (!Number.isFinite(maxGroups)) return getUserChats(userId);
  return db
    .prepare(
      `SELECT c.* FROM chats c
       WHERE c.is_active = 1 AND c.id IN (
         SELECT chat_id FROM chat_members WHERE user_id = ? ORDER BY joined_at ASC LIMIT ?
       )
       ORDER BY c.title`
    )
    .all(userId, maxGroups);
}

function isUserLinkedToChat(chatId, userId) {
  return Boolean(
    db.prepare('SELECT 1 FROM chat_members WHERE chat_id = ? AND user_id = ?').get(chatId, userId)
  );
}

function saveMessage({ chatId, messageId, userId, username, text, createdAt }) {
  db.prepare(
    `INSERT INTO messages (chat_id, message_id, user_id, username, text, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, message_id) DO NOTHING`
  ).run(chatId, messageId, userId || null, username || null, text, createdAt || new Date().toISOString());
}

function getRecentMessages(chatId, { hours = 24, limit = 200 } = {}) {
  return db
    .prepare(
      `SELECT * FROM messages
       WHERE chat_id = ? AND created_at >= datetime('now', ?)
       ORDER BY created_at ASC
       LIMIT ?`
    )
    .all(chatId, `-${hours} hours`, limit);
}

function searchMessages({ chatId, chatIds, query, limit = 20 }) {
  const like = `%${query}%`;

  if (chatId) {
    return db
      .prepare(
        `SELECT m.*, c.title as chat_title FROM messages m
         JOIN chats c ON c.id = m.chat_id
         WHERE m.chat_id = ? AND m.text LIKE ?
         ORDER BY m.created_at DESC LIMIT ?`
      )
      .all(chatId, like, limit);
  }

  if (!chatIds || chatIds.length === 0) return [];

  const placeholders = chatIds.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT m.*, c.title as chat_title FROM messages m
       JOIN chats c ON c.id = m.chat_id
       WHERE m.chat_id IN (${placeholders}) AND m.text LIKE ?
       ORDER BY m.created_at DESC LIMIT ?`
    )
    .all(...chatIds, like, limit);
}

function getSummaryUsageToday(userId) {
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare('SELECT summary_count FROM daily_usage WHERE user_id = ? AND date = ?').get(userId, today);
  return row ? row.summary_count : 0;
}

function incrementSummaryUsage(userId) {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO daily_usage (user_id, date, summary_count) VALUES (?, ?, 1)
     ON CONFLICT(user_id, date) DO UPDATE SET summary_count = summary_count + 1`
  ).run(userId, today);
}

function getScheduledDigest(chatId, userId) {
  return db.prepare('SELECT * FROM scheduled_digests WHERE chat_id = ? AND user_id = ?').get(chatId, userId);
}

function setScheduledDigest({ chatId, userId, hourUtc }) {
  db.prepare(
    `INSERT INTO scheduled_digests (chat_id, user_id, hour_utc, enabled)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(chat_id, user_id) DO UPDATE SET hour_utc = excluded.hour_utc, enabled = 1`
  ).run(chatId, userId, hourUtc);
}

function disableScheduledDigest(chatId, userId) {
  db.prepare('UPDATE scheduled_digests SET enabled = 0 WHERE chat_id = ? AND user_id = ?').run(chatId, userId);
}

function getDueScheduledDigests(hourUtc) {
  return db
    .prepare(
      `SELECT sd.chat_id, sd.user_id, sd.hour_utc, c.title as chat_title
       FROM scheduled_digests sd
       JOIN chats c ON c.id = sd.chat_id
       WHERE sd.enabled = 1 AND sd.hour_utc = ? AND c.is_active = 1`
    )
    .all(hourUtc);
}

function markDigestSent(chatId, userId) {
  db.prepare(`UPDATE scheduled_digests SET last_sent_at = datetime('now') WHERE chat_id = ? AND user_id = ?`).run(
    chatId,
    userId
  );
}

function getCachedDigestSummary(chatId, hours, language, fingerprint) {
  const row = db
    .prepare(
      `SELECT summary_text FROM digest_cache
       WHERE chat_id = ? AND hours = ? AND language = ? AND fingerprint = ?`
    )
    .get(chatId, hours, language, fingerprint);
  return row ? row.summary_text : null;
}

function setCachedDigestSummary(chatId, hours, language, fingerprint, summaryText) {
  db.prepare(
    `INSERT INTO digest_cache (chat_id, hours, language, fingerprint, summary_text)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, hours, language) DO UPDATE SET
       fingerprint = excluded.fingerprint,
       summary_text = excluded.summary_text,
       created_at = datetime('now')`
  ).run(chatId, hours, language, fingerprint, summaryText);
}

function getUserLanguage(userId) {
  const row = db.prepare('SELECT language FROM users WHERE id = ?').get(userId);
  return row && row.language ? row.language : null;
}

function setUserLanguage(userId, language) {
  db.prepare('UPDATE users SET language = ? WHERE id = ?').run(language, userId);
}

function purgeExpiredMessages(retentionDays) {
  const result = db
    .prepare(`DELETE FROM messages WHERE created_at < datetime('now', ?)`)
    .run(`-${retentionDays} days`);
  return result.changes;
}

function purgeRemovedChatData(graceDays) {
  const chats = db
    .prepare(
      `SELECT id FROM chats
       WHERE is_active = 0 AND deactivated_at IS NOT NULL
         AND deactivated_at < datetime('now', ?)`
    )
    .all(`-${graceDays} days`);

  let purged = 0;
  for (const chat of chats) {
    const result = db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chat.id);
    db.prepare('DELETE FROM digest_cache WHERE chat_id = ?').run(chat.id);
    // Clear the marker so the same chat isn't rescanned on every sweep.
    db.prepare('UPDATE chats SET deactivated_at = NULL WHERE id = ?').run(chat.id);
    purged += result.changes;
  }
  return { chats: chats.length, messages: purged };
}

function getUserDataSummary(userId) {
  const messages = db.prepare('SELECT COUNT(*) as c FROM messages WHERE user_id = ?').get(userId);
  const chats = db.prepare('SELECT COUNT(*) as c FROM chat_members WHERE user_id = ?').get(userId);
  const oldest = db
    .prepare('SELECT MIN(created_at) as t FROM messages WHERE user_id = ?')
    .get(userId);
  return {
    messageCount: messages ? messages.c : 0,
    chatCount: chats ? chats.c : 0,
    oldestMessageAt: oldest ? oldest.t : null,
  };
}

// Deletes the personal data we hold for a user. Deliberately does NOT delete
// the users row or their subscriptions: cascading from users would destroy
// payment records they may need for support or refunds. Analytics events are
// anonymized rather than dropped so aggregate funnel numbers stay intact.
function deleteUserData(userId) {
  const affectedChats = db
    .prepare('SELECT DISTINCT chat_id FROM messages WHERE user_id = ?')
    .all(userId);

  db.exec('BEGIN');
  try {
    const deleted = db.prepare('DELETE FROM messages WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM user_filters WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM chat_members WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM scheduled_digests WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM daily_usage WHERE user_id = ?').run(userId);
    db.prepare('UPDATE events SET user_id = NULL WHERE user_id = ?').run(userId);

    // Cached summaries were generated from text that included this user's
    // messages, so they must be invalidated too or deleted content lives on.
    for (const { chat_id: chatId } of affectedChats) {
      db.prepare('DELETE FROM digest_cache WHERE chat_id = ?').run(chatId);
    }

    db.exec('COMMIT');
    return { messagesDeleted: deleted.changes, chatsAffected: affectedChats.length };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function logEvent(eventType, { userId, chatId, metadata } = {}) {
  db.prepare('INSERT INTO events (user_id, chat_id, event_type, metadata) VALUES (?, ?, ?, ?)').run(
    userId || null,
    chatId || null,
    eventType,
    metadata ? JSON.stringify(metadata) : null
  );
}

function getEventCounts(sinceDays) {
  return db
    .prepare(
      `SELECT event_type, COUNT(*) as count, COUNT(DISTINCT user_id) as unique_users
       FROM events
       WHERE created_at >= datetime('now', ?)
       GROUP BY event_type
       ORDER BY count DESC`
    )
    .all(`-${sinceDays} days`);
}

function getDistinctEventUsers(eventTypes, sinceDays) {
  const placeholders = eventTypes.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT DISTINCT user_id FROM events
       WHERE event_type IN (${placeholders}) AND user_id IS NOT NULL AND created_at >= datetime('now', ?)`
    )
    .all(...eventTypes, `-${sinceDays} days`)
    .map((r) => r.user_id);
}

/**
 * Rolling retention: of users who joined at least N days ago, how many did
 * anything at all on or after (join date + N days).
 *
 * The `eligible` filter is the part that's easy to get wrong. A user who signed
 * up yesterday cannot possibly have 7-day retention yet, so counting them in
 * the denominator would drag D7 down every time you acquire new users — making
 * growth look like churn. Only users who have actually had the chance to return
 * are counted.
 */
function getRetentionCurve(dayOffsets = [1, 7, 30]) {
  const stmt = db.prepare(
    `SELECT
       COUNT(*) AS eligible,
       COALESCE(SUM(CASE WHEN EXISTS (
         SELECT 1 FROM events e
         WHERE e.user_id = u.id
           AND e.created_at >= datetime(u.created_at, ?)
       ) THEN 1 ELSE 0 END), 0) AS retained
     FROM users u
     WHERE u.created_at <= datetime('now', ?)`
  );

  return dayOffsets.map((days) => {
    const row = stmt.get(`+${days} days`, `-${days} days`);
    const eligible = row ? row.eligible : 0;
    const retained = row ? row.retained : 0;
    return {
      days,
      eligible,
      retained,
      pct: eligible > 0 ? (retained / eligible) * 100 : null,
    };
  });
}

/**
 * Weekly signup cohorts with rolling retention per cohort.
 *
 * Cohorts are keyed by the Monday of the week a user first appeared, so you can
 * see whether newer cohorts retain better than older ones — the signal that
 * tells you a product change worked, which a single blended number hides.
 */
function getWeeklyCohorts(limitWeeks = 8) {
  return db
    .prepare(
      `SELECT
         date(u.created_at, 'weekday 0', '-6 days') AS cohort_start,
         COUNT(*) AS size,
         COALESCE(SUM(CASE WHEN u.created_at <= datetime('now', '-1 days') THEN 1 ELSE 0 END), 0) AS eligible_d1,
         COALESCE(SUM(CASE WHEN u.created_at <= datetime('now', '-7 days') THEN 1 ELSE 0 END), 0) AS eligible_d7,
         COALESCE(SUM(CASE WHEN u.created_at <= datetime('now', '-1 days') AND EXISTS (
           SELECT 1 FROM events e WHERE e.user_id = u.id
             AND e.created_at >= datetime(u.created_at, '+1 days')
         ) THEN 1 ELSE 0 END), 0) AS retained_d1,
         COALESCE(SUM(CASE WHEN u.created_at <= datetime('now', '-7 days') AND EXISTS (
           SELECT 1 FROM events e WHERE e.user_id = u.id
             AND e.created_at >= datetime(u.created_at, '+7 days')
         ) THEN 1 ELSE 0 END), 0) AS retained_d7
       FROM users u
       GROUP BY cohort_start
       ORDER BY cohort_start DESC
       LIMIT ?`
    )
    .all(limitWeeks);
}

/** Distinct users who did anything on each of the last N days. */
function getDailyActiveUsers(days = 14) {
  return db
    .prepare(
      `SELECT date(created_at) AS day,
              COUNT(DISTINCT user_id) AS active_users,
              COUNT(*) AS events
       FROM events
       WHERE user_id IS NOT NULL AND created_at >= datetime('now', ?)
       GROUP BY day
       ORDER BY day DESC`
    )
    .all(`-${days} days`);
}

function createSubscription({ userId, plan, starsPaid, telegramChargeId, expiresAt }) {
  const result = db
    .prepare(
      `INSERT INTO subscriptions (user_id, plan, stars_paid, telegram_charge_id, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(userId, plan, starsPaid, telegramChargeId || null, expiresAt || null);
  return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(result.lastInsertRowid);
}

function getActiveSubscription(userId) {
  return db
    .prepare(
      `SELECT * FROM subscriptions
       WHERE user_id = ? AND status = 'active'
         AND (expires_at IS NULL OR expires_at > datetime('now'))
       ORDER BY started_at DESC
       LIMIT 1`
    )
    .get(userId);
}

module.exports = {
  db,
  getOrCreateUser,
  getUserFilters,
  setUserFilters,
  getOrCreateChat,
  deactivateChat,
  linkUserToChat,
  getUserChats,
  getAllowedUserChats,
  isChatWithinFreeLimit,
  isUserLinkedToChat,
  saveMessage,
  getRecentMessages,
  searchMessages,
  getSummaryUsageToday,
  incrementSummaryUsage,
  getScheduledDigest,
  setScheduledDigest,
  disableScheduledDigest,
  getDueScheduledDigests,
  markDigestSent,
  getCachedDigestSummary,
  setCachedDigestSummary,
  getUserLanguage,
  setUserLanguage,
  purgeExpiredMessages,
  purgeRemovedChatData,
  getUserDataSummary,
  deleteUserData,
  logEvent,
  getEventCounts,
  getDistinctEventUsers,
  getRetentionCurve,
  getWeeklyCohorts,
  getDailyActiveUsers,
  createSubscription,
  getActiveSubscription,
};
