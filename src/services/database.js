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

  -- One row per reminder actually delivered. Keyed on the SUBSCRIPTION and
  -- not the user, so a renewed subscriber gets a fresh set of reminders as
  -- their new period runs down - "once per user, ever" would mean reminding a
  -- loyal customer exactly once and never again.
  CREATE TABLE IF NOT EXISTS subscription_reminders (
    subscription_id INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,
    user_id INTEGER,
    sent_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (subscription_id, stage)
  );

  CREATE INDEX IF NOT EXISTS idx_subscription_reminders_user ON subscription_reminders(user_id, sent_at);

  -- Operational bookkeeping the bot needs to remember across restarts. Not
  -- product data and never user data: nothing in here is subject to retention
  -- or /forgetme, which is why it is a table of its own rather than an event.
  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
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

// 'bot'     — a group the bot was added to; messages arrive as updates.
// 'channel' — a public channel read from its web preview at request time.
addColumnIfMissing('chats', 'source', `TEXT NOT NULL DEFAULT 'bot'`);
addColumnIfMissing('chats', 'username', 'TEXT');

// Why a digest is off, when it is off. Without it, "disabled" covers both the
// user switching it off and the bot switching it off because they blocked it,
// and /status can only describe one of those honestly.
addColumnIfMissing('scheduled_digests', 'disabled_reason', 'TEXT');

// One row per channel, no matter how many users follow it. Handles are stored
// lowercased so @Durov and @durov cannot become two chats holding two copies
// of the same content.
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_channel_username
    ON chats(username) WHERE source = 'channel';
`);

/**
 * Comped rows were inserted by hand with a made-up charge id, and two of them
 * sharing that placeholder is exactly what stopped the index below from being
 * created on the live database.
 *
 * A row where no stars changed hands cannot correspond to a real Telegram
 * charge — plans cost 300 or 3000, and stars_paid is copied straight from the
 * payment total — so a charge id on such a row is by definition a placeholder
 * and belongs at NULL, which the partial index ignores.
 *
 * Idempotent and safe to re-run on a live database: after the first pass there
 * is nothing left to match, and it can never touch a row that recorded money.
 */
function nullPlaceholderChargeIds() {
  const { changes } = db
    .prepare(
      `UPDATE subscriptions SET telegram_charge_id = NULL
       WHERE stars_paid = 0 AND telegram_charge_id IS NOT NULL`
    )
    .run();
  if (changes > 0) {
    logger.info(`Migration: cleared placeholder charge ids on ${changes} comped subscription(s)`);
  }
  return Number(changes);
}

/**
 * One row per Telegram charge. Telegram re-delivers an update it did not see
 * acknowledged, so without this a redelivered successful_payment grants a
 * second subscription period for one payment. Partial, because comped and
 * legacy rows carry no charge id and must not collide with each other.
 *
 * Guarded rather than asserted: a database that already contains a duplicate
 * (which is the very bug this prevents) must not become a bot that refuses to
 * start. Log it and carry on — createSubscription still deduplicates in code.
 */
function ensureChargeIdIndex() {
  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_charge_id
        ON subscriptions(telegram_charge_id) WHERE telegram_charge_id IS NOT NULL;
    `);
    return true;
  } catch (error) {
    logger.error(
      'Could not add the unique index on subscriptions.telegram_charge_id — there are already duplicate charge ids',
      { error: error.message }
    );
    return false;
  }
}

// Order matters: the placeholders have to go before the index that they block.
nullPlaceholderChargeIds();
ensureChargeIdIndex();

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

function getChatById(chatId) {
  return db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
}

// Scraped channels have no Bot API chat id, so they need one of our own, and a
// synthetic id that ever collided with a real chat id would serve one chat's
// content to another chat's members — the worst bug this feature could have.
//
// Telegram gives groups, supergroups and channels *negative* ids, and this
// table only ever holds those (ingestion filters on isGroupChat, so a private
// chat's positive id never lands here). Allocating channels from a high
// positive range therefore cannot collide by construction, not merely by luck.
// idsAreNamespaced() is asserted in the test suite.
const CHANNEL_ID_BASE = 1_000_000_000_000;

function allocateChannelId() {
  const row = db
    .prepare('SELECT COALESCE(MAX(id), ?) AS max_id FROM chats WHERE id >= ?')
    .get(CHANNEL_ID_BASE - 1, CHANNEL_ID_BASE);
  return row.max_id + 1;
}

function getChannelByUsername(username) {
  return db
    .prepare(`SELECT * FROM chats WHERE source = 'channel' AND username = ?`)
    .get(String(username).toLowerCase());
}

function getOrCreateChannel({ username, title, addedBy }) {
  const handle = String(username).toLowerCase();

  const existing = getChannelByUsername(handle);
  if (existing) {
    if (title && title !== existing.title) {
      db.prepare('UPDATE chats SET title = ? WHERE id = ?').run(title, existing.id);
    }
    if (!existing.is_active) {
      db.prepare('UPDATE chats SET is_active = 1, deactivated_at = NULL WHERE id = ?').run(existing.id);
    }
    return getChatById(existing.id);
  }

  // Allocate and insert atomically: without the transaction two concurrent
  // /addchannel calls can read the same MAX(id) and race for one id.
  db.exec('BEGIN IMMEDIATE');
  try {
    const id = allocateChannelId();
    db.prepare(
      `INSERT INTO chats (id, title, type, source, username, added_by)
       VALUES (?, ?, 'channel', 'channel', ?, ?)`
    ).run(id, title || handle, handle, addedBy || null);
    db.exec('COMMIT');
    return getChatById(id);
  } catch (error) {
    db.exec('ROLLBACK');
    // Lost the race against another caller adding the same channel: the
    // partial unique index rejected the duplicate, and their row is fine.
    const raced = getChannelByUsername(handle);
    if (raced) return raced;
    throw error;
  }
}

function getUserGroups(userId) {
  return db
    .prepare(
      `SELECT c.* FROM chats c
       JOIN chat_members cm ON cm.chat_id = c.id
       WHERE cm.user_id = ? AND c.is_active = 1 AND c.source = 'bot'
       ORDER BY c.title`
    )
    .all(userId);
}

function getUserChannels(userId) {
  return db
    .prepare(
      `SELECT c.* FROM chats c
       JOIN chat_members cm ON cm.chat_id = c.id
       WHERE cm.user_id = ? AND c.is_active = 1 AND c.source = 'channel'
       ORDER BY c.title`
    )
    .all(userId);
}

function unlinkUserFromChat(chatId, userId) {
  const result = db
    .prepare('DELETE FROM chat_members WHERE chat_id = ? AND user_id = ?')
    .run(chatId, userId);
  return result.changes > 0;
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
// Groups and channels have separate allowances, so neither can eat the other's
// slots. Both work the same way: the earliest N a user joined are the ones they
// can use, which means a lapsed subscriber keeps their oldest and loses the
// rest rather than losing everything at once.
//
// chat_id breaks ties because joined_at is stored to the second, so two
// channels added in the same second would otherwise have no defined order and
// a user could see a different one allowed on each request.
//
// Inactive chats are excluded from the ranking, not merely from the result. A
// group the bot was removed from would otherwise still occupy a slot: a free
// user whose earliest group went dead had their single allowance spent on it
// and could summarize nothing at all, while still being shown the live group
// they are a member of.
function isWithinSourceLimit(userId, chatId, max, source) {
  if (!Number.isFinite(max)) return true;
  if (max <= 0) return false;
  const row = db
    .prepare(
      `SELECT 1 FROM (
         SELECT cm.chat_id FROM chat_members cm
         JOIN chats c ON c.id = cm.chat_id
         WHERE cm.user_id = ? AND c.source = ? AND c.is_active = 1
         ORDER BY cm.joined_at ASC, cm.chat_id ASC LIMIT ?
       ) WHERE chat_id = ?`
    )
    .get(userId, source, max, chatId);
  return Boolean(row);
}

function isChatWithinFreeLimit(userId, chatId, maxGroups) {
  return isWithinSourceLimit(userId, chatId, maxGroups, 'bot');
}

function isChannelWithinLimit(userId, chatId, maxChannels) {
  return isWithinSourceLimit(userId, chatId, maxChannels, 'channel');
}

function getAllowedUserChannels(userId, maxChannels) {
  if (!Number.isFinite(maxChannels)) return getUserChannels(userId);
  if (maxChannels <= 0) return [];
  return db
    .prepare(
      `SELECT c.* FROM chats c
       WHERE c.is_active = 1 AND c.source = 'channel' AND c.id IN (
         SELECT cm.chat_id FROM chat_members cm
         JOIN chats c2 ON c2.id = cm.chat_id
         WHERE cm.user_id = ? AND c2.source = 'channel' AND c2.is_active = 1
         ORDER BY cm.joined_at ASC, cm.chat_id ASC LIMIT ?
       )
       ORDER BY c.title`
    )
    .all(userId, maxChannels);
}

function getAllowedUserChats(userId, maxGroups) {
  if (!Number.isFinite(maxGroups)) return getUserGroups(userId);
  return db
    .prepare(
      `SELECT c.* FROM chats c
       WHERE c.is_active = 1 AND c.source = 'bot' AND c.id IN (
         SELECT cm.chat_id FROM chat_members cm
         JOIN chats c2 ON c2.id = cm.chat_id
         WHERE cm.user_id = ? AND c2.source = 'bot' AND c2.is_active = 1
         ORDER BY cm.joined_at ASC, cm.chat_id ASC LIMIT ?
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

/**
 * The window of conversation to summarize: the *newest* `limit` messages
 * inside the lookback period, returned oldest-first so the transcript reads in
 * order.
 *
 * The nesting is the whole point. A plain `ORDER BY created_at ASC LIMIT 200`
 * takes the OLDEST 200 in the window, so a group busier than the cap was
 * summarized from the start of yesterday and everything since was silently
 * dropped — a wrong answer that looks exactly like a right one. It also froze
 * the digest cache: fingerprintMessages() keys on the highest message id, and
 * with the newest messages cut off, new arrivals never changed it, so the
 * stale summary was served back indefinitely.
 *
 * id breaks the tie because created_at is stored to the second and a busy
 * group puts many messages in one.
 */
function getRecentMessages(chatId, { hours = 24, limit = 200 } = {}) {
  return db
    .prepare(
      `SELECT * FROM (
         SELECT * FROM messages
         WHERE chat_id = ? AND created_at >= datetime('now', ?)
         ORDER BY created_at DESC, id DESC
         LIMIT ?
       ) ORDER BY created_at ASC, id ASC`
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
     ON CONFLICT(chat_id, user_id) DO UPDATE SET hour_utc = excluded.hour_utc, enabled = 1, disabled_reason = NULL`
  ).run(chatId, userId, hourUtc);
}

/**
 * Switches a scheduled digest off.
 *
 * `reason` is recorded so /status can distinguish "you turned this off" from
 * "I turned this off because you blocked me", which otherwise look identical
 * to the person wondering where their digest went.
 */
function disableScheduledDigest(chatId, userId, reason = null) {
  db.prepare('UPDATE scheduled_digests SET enabled = 0, disabled_reason = ? WHERE chat_id = ? AND user_id = ?').run(
    reason,
    chatId,
    userId
  );
}

/** Every scheduled digest a user has, for /status. */
function getUserScheduledDigests(userId) {
  return db
    .prepare(
      `SELECT sd.chat_id, sd.hour_utc, sd.enabled, sd.disabled_reason, c.title AS chat_title
       FROM scheduled_digests sd
       JOIN chats c ON c.id = sd.chat_id
       WHERE sd.user_id = ? AND c.is_active = 1
       ORDER BY c.title`
    )
    .all(userId);
}

/**
 * The digests to deliver on this hour's tick.
 *
 * last_sent_at is what makes the tick safe to run twice. BullMQ retries a job
 * that threw, and a container restart mid-tick leaves it unfinished — either
 * one used to re-deliver every digest already sent that hour, since nothing
 * read the column markDigestSent() writes. Comparing to the hour rather than
 * to a duration is deliberate: a digest belongs to its hour, so a retry three
 * minutes later and one fifty minutes later are both already-done.
 */
function getDueScheduledDigests(hourUtc) {
  return db
    .prepare(
      `SELECT sd.chat_id, sd.user_id, sd.hour_utc, c.title as chat_title
       FROM scheduled_digests sd
       JOIN chats c ON c.id = sd.chat_id
       WHERE sd.enabled = 1 AND sd.hour_utc = ? AND c.is_active = 1
         AND (
           sd.last_sent_at IS NULL
           OR strftime('%Y-%m-%dT%H', sd.last_sent_at) <> strftime('%Y-%m-%dT%H', 'now')
         )`
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

function getAppState(key) {
  const row = db.prepare('SELECT value FROM app_state WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setAppState(key, value) {
  db.prepare(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, String(value));
}

/**
 * Subscriptions that should get the `stage` reminder and have not had it.
 *
 * The window is half-open and the stages do not overlap, so one subscription
 * cannot be caught by two of them on the same tick. It is also bounded at both
 * ends deliberately: without a lower bound, the first deploy would DM everyone
 * who ever let a subscription lapse, months after the fact.
 *
 * The last clause is what stops a reminder reaching someone who has already
 * renewed. getActiveSubscription picks the subscription running LONGEST, so a
 * row with a longer one behind it is not the one deciding their access and
 * there is nothing to remind them about.
 *
 * A NULL expires_at never matches: a comped subscription does not run out, so
 * there is no date to warn anyone about.
 */
function getSubscriptionsDueForReminder(stage, afterModifier, untilModifier) {
  return db
    .prepare(
      `SELECT s.* FROM subscriptions s
       WHERE s.status = 'active'
         AND s.expires_at IS NOT NULL
         AND s.expires_at > datetime('now', ?)
         AND s.expires_at <= datetime('now', ?)
         AND NOT EXISTS (
           SELECT 1 FROM subscription_reminders r
           WHERE r.subscription_id = s.id AND r.stage = ?
         )
         AND NOT EXISTS (
           SELECT 1 FROM subscriptions later
           WHERE later.user_id = s.user_id
             AND later.status = 'active'
             AND later.id <> s.id
             AND (later.expires_at IS NULL OR later.expires_at > s.expires_at)
         )
       ORDER BY s.expires_at`
    )
    .all(afterModifier, untilModifier, stage);
}

/**
 * Records that a stage was dealt with, so a retried tick cannot re-notify.
 *
 * INSERT OR IGNORE rather than a plain insert: the primary key is the guard,
 * and two paths reaching it is not an error worth throwing over.
 */
function markReminderSent(subscriptionId, stage, userId) {
  db.prepare(
    'INSERT OR IGNORE INTO subscription_reminders (subscription_id, stage, user_id) VALUES (?, ?, ?)'
  ).run(subscriptionId, stage, userId || null);
}

/** Did we nudge this user recently? Used to attribute a renewal to a reminder. */
function hasRecentReminder(userId, withinDays) {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM subscription_reminders
         WHERE user_id = ? AND sent_at >= datetime('now', ?) LIMIT 1`
      )
      .get(userId, `-${withinDays} days`)
  );
}

/**
 * Takes a subscription out of circulation without deleting the billing record.
 *
 * getActiveSubscription filters on status = 'active', so anything else here -
 * 'refunded', 'revoked' - stops granting access the moment it is written, while
 * the row survives as the history of what was charged and what was given back.
 */
function setSubscriptionStatus(subscriptionId, status) {
  const result = db.prepare('UPDATE subscriptions SET status = ? WHERE id = ?').run(status, subscriptionId);
  return Number(result.changes);
}

/** Every live subscription a user has, revoked at once. Returns how many. */
function revokeActiveSubscriptions(userId) {
  const result = db
    .prepare("UPDATE subscriptions SET status = 'revoked' WHERE user_id = ? AND status = 'active'")
    .run(userId);
  return Number(result.changes);
}

function getSubscriptionByChargeId(telegramChargeId) {
  if (!telegramChargeId) return undefined;
  return db.prepare('SELECT * FROM subscriptions WHERE telegram_charge_id = ?').get(telegramChargeId);
}

/**
 * Records a purchase, once per Telegram charge.
 *
 * Telegram retries an update it did not see acknowledged, so the same
 * successful_payment can arrive more than once — after a deploy, a timeout, or
 * a crash between receiving it and replying. Each redelivery used to insert
 * another row and hand out another 30 days for one payment. The charge id is
 * the natural idempotency key, and returning the existing row rather than
 * throwing keeps the caller's confirmation message correct on the retry.
 *
 * Comped subscriptions have no charge id and are never deduplicated.
 */
function createSubscription({ userId, plan, starsPaid, telegramChargeId, expiresAt }) {
  const existing = getSubscriptionByChargeId(telegramChargeId);
  if (existing) {
    logger.warn('Ignoring a redelivered payment for a charge already recorded', {
      userId,
      telegramChargeId,
      subscriptionId: existing.id,
    });
    return existing;
  }

  const result = db
    .prepare(
      `INSERT INTO subscriptions (user_id, plan, stars_paid, telegram_charge_id, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(userId, plan, starsPaid, telegramChargeId || null, expiresAt || null);
  return db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(result.lastInsertRowid);
}

/**
 * The subscription that decides a user's access, which is the one running
 * *longest* — not the one started most recently.
 *
 * Ordering by started_at was both wrong and unstable. Wrong because a short
 * plan bought or comped on top of a long one would win and silently shorten
 * the user's access. Unstable because started_at is stored to the second, so
 * two rows created in the same second had no defined order and the answer
 * could change between requests.
 *
 * A NULL expiry means "never expires" and therefore outranks every date.
 */
function getActiveSubscription(userId) {
  return db
    .prepare(
      `SELECT * FROM subscriptions
       WHERE user_id = ? AND status = 'active'
         AND (expires_at IS NULL OR expires_at > datetime('now'))
       ORDER BY (expires_at IS NULL) DESC, expires_at DESC, id DESC
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
  getChatById,
  getOrCreateChannel,
  getChannelByUsername,
  deactivateChat,
  linkUserToChat,
  unlinkUserFromChat,
  getUserChats,
  getUserGroups,
  getUserChannels,
  getAllowedUserChats,
  getAllowedUserChannels,
  isChannelWithinLimit,
  CHANNEL_ID_BASE,
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
  getUserScheduledDigests,
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
  setSubscriptionStatus,
  revokeActiveSubscriptions,
  getSubscriptionsDueForReminder,
  markReminderSent,
  hasRecentReminder,
  getSubscriptionByChargeId,
  getActiveSubscription,
  nullPlaceholderChargeIds,
  ensureChargeIdIndex,
  getAppState,
  setAppState,
};
