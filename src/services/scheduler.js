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
} = require('./database');
const { splitForTelegram } = require('../utils/formatters');
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

async function runDueDigests() {
  const hourUtc = new Date().getUTCHours();
  const due = getDueScheduledDigests(hourUtc);

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
      if (result) {
        const body =
          `${t(lang, 'digest.dailyHeader', { chat: entry.chat_title })}\n\n` +
          `${result.summaryText}${result.highlightBlock}`;

        // Same two hazards as the on-demand path: a digest can exceed
        // Telegram's 4096-character limit, and model output can carry
        // unbalanced Markdown. Either one otherwise loses the whole digest.
        for (const part of splitForTelegram(body)) {
          try {
            await telegram.sendMessage(entry.user_id, part, { parse_mode: 'Markdown' });
          } catch (sendError) {
            logger.warn('Digest part rejected with Markdown, resending as plain text', {
              userId: entry.user_id,
              error: sendError.message,
            });
            await telegram.sendMessage(entry.user_id, part);
          }
        }
        track(EVENTS.SCHEDULED_DIGEST_SENT, { userId: entry.user_id, chatId: entry.chat_id });
      }
      markDigestSent(entry.chat_id, entry.user_id);
    } catch (error) {
      logger.error('Scheduled digest failed', {
        chatId: entry.chat_id,
        userId: entry.user_id,
        error: error.message,
      });
    }
  }
}

function runRetentionSweep() {
  try {
    const expired = purgeExpiredMessages(config.privacy.messageRetentionDays);
    const removed = purgeRemovedChatData(config.privacy.purgeAfterRemovalDays);

    if (expired > 0 || removed.messages > 0) {
      logger.info('Retention sweep completed', {
        expiredMessages: expired,
        removedChats: removed.chats,
        removedChatMessages: removed.messages,
      });
    }
  } catch (error) {
    logger.error('Retention sweep failed', { error: error.message });
  }
}

function startScheduler() {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      if (job.name === TICK_JOB_NAME) {
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

module.exports = { startScheduler, runDueDigests, runRetentionSweep };
