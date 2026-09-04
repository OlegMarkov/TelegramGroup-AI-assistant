const { Telegram } = require('telegraf');
const { Queue, Worker } = require('bullmq');
const config = require('../config');
const logger = require('../utils/logger');
const { connection, logRedisError } = require('./queue');
const {
  getDueScheduledDigests,
  markDigestSent,
  getActiveSubscription,
  purgeExpiredMessages,
  purgeRemovedChatData,
  getUserLanguage,
  disableScheduledDigest,
  getAppState,
  setAppState,
} = require('./database');
const { splitForTelegram } = require('../utils/formatters');
const { createSender, isBlockedError, isBadRequestError } = require('../utils/telegramSend');
const { t, normalizeLanguage } = require('../utils/i18n');
const { getLimits } = require('../models/subscription');
const { generateDigest } = require('./digest');
const { track, EVENTS } = require('./analytics');

const QUEUE_NAME = 'scheduler-jobs';
const TICK_JOB_NAME = 'digest-tick';
const DIGEST_LOOKBACK_HOURS = 24;

const telegram = new Telegram(config.botToken);
const schedulerQueue = new Queue(QUEUE_NAME, { connection });
// Recovery is detected via the shared connection's 'ready' listener in queue.js.
schedulerQueue.on('error', (err) => logRedisError('scheduler queue', err));

async function registerRepeatableTick() {
  // Runs at the top of every UTC hour; the processor only acts on digests
  // whose configured hour_utc matches the current hour.
  await schedulerQueue.add(
    TICK_JOB_NAME,
    {},
    { repeat: { pattern: '0 * * * *' }, jobId: TICK_JOB_NAME }
  );
}

async function runDueDigests({ sleep } = {}) {
  const hourUtc = new Date().getUTCHours();
  const due = getDueScheduledDigests(hourUtc);

  // One sender for the whole batch, so the pacing spans every recipient rather
  // than resetting for each one — which would pace nothing at all.
  const sender = createSender(sleep ? { sleep } : {});

  for (const entry of due) {
    const subscription = getActiveSubscription(entry.user_id);
    const limits = getLimits(subscription);

    if (!limits.scheduledDigests) {
      logger.info(`Skipping digest for user ${entry.user_id}: subscription is not active`);
      continue;
    }

    try {
      const lang = normalizeLanguage(getUserLanguage(entry.user_id));
      const result = await generateDigest(entry.chat_id, entry.user_id, DIGEST_LOOKBACK_HOURS, lang);

      if (!result) {
        // Nothing happened in the window. There is no digest to send, but the
        // hour has been dealt with, so record it and move on.
        markDigestSent(entry.chat_id, entry.user_id);
        continue;
      }

      const body =
        `${t(lang, 'digest.dailyHeader', { chat: entry.chat_title })}\n\n` +
        `${result.summaryText}${result.highlightBlock}`;

      for (const part of splitForTelegram(body)) {
        await sender.send(async () => {
          // Same two hazards as the on-demand path: a digest can exceed
          // Telegram's 4096-character limit, and model output can carry
          // unbalanced Markdown. Either one otherwise loses the whole digest.
          try {
            await telegram.sendMessage(entry.user_id, part, { parse_mode: 'Markdown' });
          } catch (sendError) {
            // Only a 400 means "I could not parse that". A block, a rate limit
            // or a dropped connection would fail identically as plain text, so
            // hand those back to the sender, which knows what to do with them
            // and would otherwise lose the formatting for no reason.
            if (!isBadRequestError(sendError)) throw sendError;

            logger.warn('Digest part rejected with Markdown, resending as plain text', {
              userId: entry.user_id,
              error: sendError.message,
            });
            await telegram.sendMessage(entry.user_id, part);
          }
        });
      }

      track(EVENTS.SCHEDULED_DIGEST_SENT, { userId: entry.user_id, chatId: entry.chat_id });

      // Only after the send actually succeeded. Marked any earlier and the
      // per-hour guard would suppress the retry this failure should get.
      markDigestSent(entry.chat_id, entry.user_id);
    } catch (error) {
      // A user who blocked the bot returns 403 on every send, for ever. Their
      // digest stayed enabled, so the tick tried again the next day and every
      // day after — invisible noise that grows with every user who leaves.
      if (isBlockedError(error)) {
        disableScheduledDigest(entry.chat_id, entry.user_id);
        track(EVENTS.DIGEST_DISABLED_BLOCKED, { userId: entry.user_id, chatId: entry.chat_id });
        logger.info('Disabled a scheduled digest because the user blocked the bot', {
          chatId: entry.chat_id,
          userId: entry.user_id,
        });
        // Their data is untouched: blocking the bot is not a deletion request.
        continue;
      }

      // Everything else stays enabled and is simply logged, loudly enough to
      // be findable by user id. One person's failure never ends the loop.
      logger.error('Scheduled digest failed', {
        chatId: entry.chat_id,
        userId: entry.user_id,
        error: error.message,
      });
    }
  }
}

const RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
const SWEEP_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

// Two callers now drive the sweep — the timer below and the BullMQ tick — and a
// sweep this recent has already deleted everything another one would find. The
// gap makes the second caller free rather than making it a special case.
const SWEEP_MIN_GAP_MS = 5 * 60 * 1000;

// Persisted rather than held in memory, because the question it answers — "is
// retention actually running?" — has to survive a restart to be worth asking.
// A bot that crash-loops every hour would otherwise reset the clock on every
// boot and never look overdue, which is precisely the silent failure this is
// here to make visible.
const LAST_SWEEP_KEY = 'retention_swept_at';

function readLastSweepAt() {
  const stored = Number(getAppState(LAST_SWEEP_KEY));
  return Number.isFinite(stored) && stored > 0 ? stored : null;
}

/**
 * Deletes what retention says should be gone.
 *
 * PRIVACY.md promises messages are deleted after a fixed number of days. That
 * promise used to be kept only while Redis was up, because the sweep rode the
 * BullMQ tick — so a long Redis outage meant the bot kept answering perfectly
 * while quietly retaining data past what its own policy allows. Nothing looked
 * wrong, which is what made it worth fixing over an outage that announces
 * itself. It is a synchronous SQLite delete with no queue semantics; it never
 * needed a job queue in the first place.
 */
function runRetentionSweep({ force = false } = {}) {
  const lastSweepAt = readLastSweepAt();
  if (!force && lastSweepAt !== null && Date.now() - lastSweepAt < SWEEP_MIN_GAP_MS) return false;

  try {
    const expired = purgeExpiredMessages(config.privacy.messageRetentionDays);
    const removed = purgeRemovedChatData(config.privacy.purgeAfterRemovalDays);
    setAppState(LAST_SWEEP_KEY, Date.now());

    if (expired > 0 || removed.messages > 0) {
      logger.info('Retention sweep completed', {
        expiredMessages: expired,
        removedChats: removed.chats,
        removedChatMessages: removed.messages,
      });
    }
    return true;
  } catch (error) {
    // The stored timestamp is deliberately not advanced: a failing sweep has
    // to go stale and trip the warning below, rather than look like it ran.
    logger.error('Retention sweep failed', { error: error.message });
    return false;
  }
}

/**
 * Runs the sweep on a plain timer, independent of Redis, BullMQ and Telegram.
 *
 * unref'd so it can never be the reason the process stays alive — the same
 * treatment uiState gives its cleanup timer.
 */
function startRetentionSweeps() {
  runRetentionSweep({ force: true });

  const timer = setInterval(() => {
    runRetentionSweep();

    // A sweep that silently stopped working is the failure this whole change
    // is about, so it has to be visible somewhere other than an absence of
    // log lines.
    const lastSweepAt = readLastSweepAt();
    if (lastSweepAt === null || Date.now() - lastSweepAt > SWEEP_STALE_AFTER_MS) {
      logger.warn('Retention has not swept successfully in over 24 hours — data may be past its promised expiry', {
        hoursSinceLastSweep: lastSweepAt === null ? 'never' : Math.round((Date.now() - lastSweepAt) / 3600000),
      });
    }
  }, RETENTION_SWEEP_INTERVAL_MS);

  timer.unref();
  return () => clearInterval(timer);
}

function startScheduler() {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === TICK_JOB_NAME) {
        // Redundant with the timer in startRetentionSweeps, and kept anyway:
        // the gap guard makes it a no-op in the normal case, and it costs one
        // comparison to have a second path that would still enforce retention.
        runRetentionSweep();
        await runDueDigests();
      }
    },
    { connection }
  );

  worker.on('error', (err) => logRedisError('scheduler worker', err));

  registerRepeatableTick().catch((err) =>
    logger.error('Failed to register digest scheduler tick', { error: err.message })
  );

  return worker;
}

module.exports = {
  startScheduler,
  runDueDigests,
  runRetentionSweep,
  startRetentionSweeps,
};
