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
  getSubscriptionsDueForReminder,
  markReminderSent,
  getAppState,
  setAppState,
} = require('./database');
const { splitForTelegram } = require('../utils/formatters');
const { createSender, isBlockedError, isBadRequestError } = require('../utils/telegramSend');
const { SpendCapReachedError } = require('./aiBudget');
const { feedbackKeyboard } = require('../commands/feedback');
const { t, normalizeLanguage } = require('../utils/i18n');
const { getLimits, FREE_LIMITS, PREMIUM_LIMITS, TRIAL_PLAN } = require('../models/subscription');
const { planLabel } = require('../keyboards');
const { generateDigest } = require('./digest');
const { track, EVENTS } = require('./analytics');

const QUEUE_NAME = 'scheduler-jobs';
const TICK_JOB_NAME = 'digest-tick';
const DIGEST_LOOKBACK_HOURS = 24;
const WEEKLY_LOOKBACK_HOURS = 24 * 7;

/**
 * A weekly digest is exempt from PREMIUM_LIMITS.maxLookbackHours (72).
 *
 * That cap exists to bound what a user can ask for on demand — it is a spend
 * and abuse control on /summary, where anyone can type a number. A weekly
 * digest is not a request, it is a schedule the user configured once, it fires
 * at most once a week, and 168 hours IS the feature: clamping it to 72 would
 * silently deliver a three-day digest under a "past week" heading, which is
 * the same class of quiet wrongness as the 200-message cap.
 *
 * Raising the cap itself was the alternative and is worse: it would also raise
 * what every on-demand /summary can pull, which is exactly what it is there to
 * prevent. Exempting the one scheduled path keeps the control where it belongs.
 */
function lookbackFor(entry) {
  return entry.cadence === 'weekly' ? WEEKLY_LOOKBACK_HOURS : DIGEST_LOOKBACK_HOURS;
}

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
      const hours = lookbackFor(entry);
      const result = await generateDigest(entry.chat_id, entry.user_id, hours, lang);

      if (!result) {
        // Nothing happened in the window. There is no digest to send, but the
        // hour has been dealt with, so record it and move on.
        markDigestSent(entry.chat_id, entry.user_id);
        continue;
      }

      // Same footer as the on-demand path, assembled per request rather than
      // cached, and only for groups.
      const footer = result.isChannel ? '' : `\n\n${t(lang, 'summary.footer')}`;
      const truncatedNote = result.truncated
        ? `\n${t(lang, 'summary.truncatedNote', { shown: result.messageCount, total: result.totalAvailable })}`
        : '';
      const header =
        entry.cadence === 'weekly'
          ? t(lang, 'digest.weeklyHeader', { chat: entry.chat_title })
          : t(lang, 'digest.dailyHeader', { chat: entry.chat_title });

      const body = `${header}${truncatedNote}\n\n${result.summaryText}${result.highlightBlock}${footer}`;

      const parts = splitForTelegram(body);

      for (const [index, part] of parts.entries()) {
        // Last part only, same as the on-demand path.
        const extra = index === parts.length - 1 ? feedbackKeyboard(lang, { chatId: entry.chat_id, hours }) : {};

        await sender.send(async () => {
          // Same two hazards as the on-demand path: a digest can exceed
          // Telegram's 4096-character limit, and model output can carry
          // unbalanced Markdown. Either one otherwise loses the whole digest.
          try {
            await telegram.sendMessage(entry.user_id, part, { parse_mode: 'Markdown', ...extra });
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
            await telegram.sendMessage(entry.user_id, part, extra);
          }
        });
      }

      track(EVENTS.SCHEDULED_DIGEST_SENT, { userId: entry.user_id, chatId: entry.chat_id });

      // Only after the send actually succeeded. Marked any earlier and the
      // per-hour guard would suppress the retry this failure should get.
      markDigestSent(entry.chat_id, entry.user_id);
    } catch (error) {
      // The daily AI budget is spent. Skip without marking the hour done, so
      // the next tick can deliver it if an admin adds room — and without
      // retrying inside this tick, which would just hit the same wall for
      // every remaining recipient.
      if (error instanceof SpendCapReachedError) {
        logger.warn('Skipping a scheduled digest: daily AI budget reached', {
          chatId: entry.chat_id,
          userId: entry.user_id,
          usage: error.usage,
          limit: error.limit,
        });
        continue;
      }

      // A user who blocked the bot returns 403 on every send, for ever. Their
      // digest stayed enabled, so the tick tried again the next day and every
      // day after — invisible noise that grows with every user who leaves.
      if (isBlockedError(error)) {
        disableScheduledDigest(entry.chat_id, entry.user_id, 'blocked');
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

/**
 * Nothing told a subscriber their period was ending. They lost premium in
 * silence, and most people do not connect "my digest stopped" with "my
 * subscription lapsed" - they assume the bot broke and drift away. Every lapse
 * was a churn event nobody saw and nobody got a chance to prevent.
 *
 * Three stages, in half-open windows that cannot overlap, so one subscription
 * is never caught twice on the same tick. The lower bound on the last stage
 * matters: without it the first deploy would DM everyone who ever let a
 * subscription lapse, months after the fact.
 */
const REMINDER_STAGES = [
  { stage: 'expiring_3d', after: '+1 days', until: '+3 days', days: 3 },
  { stage: 'expiring_1d', after: '+0 days', until: '+1 days', days: 1 },
  { stage: 'expired', after: '-1 days', until: '+0 days', days: 0 },
];

function reminderText(lang, stage, subscription) {
  // A trial cannot be renewed, only bought, so it gets its own wording. The
  // last day of a trial is the best moment there will ever be to ask for the
  // sale, and "renew your trial" is not the sentence that does it.
  const prefix = subscription.plan === TRIAL_PLAN ? 'reminder.trial_' : 'reminder.';

  return t(lang, `${prefix}${stage.stage}`, {
    plan: planLabel(lang, subscription.plan),
    days: stage.days,
    expires: String(subscription.expires_at).slice(0, 10),
    premiumChannels: PREMIUM_LIMITS.maxChannels,
    freeSummaries: FREE_LIMITS.maxSummariesPerDay,
    freeGroups: FREE_LIMITS.maxGroups,
    freeChannels: FREE_LIMITS.maxChannels,
    freeKeywords: FREE_LIMITS.maxKeywords,
  });
}

async function runExpiryReminders({ sleep } = {}) {
  const sender = createSender(sleep ? { sleep } : {});

  for (const stage of REMINDER_STAGES) {
    for (const subscription of getSubscriptionsDueForReminder(stage.stage, stage.after, stage.until)) {
      const userId = subscription.user_id;

      try {
        const lang = normalizeLanguage(getUserLanguage(userId));

        await sender.send(() =>
          telegram.sendMessage(userId, reminderText(lang, stage, subscription), {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[{ text: t(lang, 'reminder.renewButton'), callback_data: 'renew:open' }]],
            },
          })
        );

        // Written only after the send succeeded, for the same reason
        // markDigestSent is: a failure has to stay retryable.
        markReminderSent(subscription.id, stage.stage, userId);
        track(EVENTS.REMINDER_SENT, { userId, metadata: { stage: stage.stage } });
      } catch (error) {
        if (isBlockedError(error)) {
          // Recorded as dealt with even though it never arrived. They cannot be
          // reached, and the alternative is retrying every hour for the whole
          // window - the same unbounded waste case-11 removed for digests.
          markReminderSent(subscription.id, stage.stage, userId);
          logger.info('Skipping an expiry reminder for a user who blocked the bot', { userId });
          continue;
        }

        logger.error('Expiry reminder failed', { userId, stage: stage.stage, error: error.message });
      }
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

// Daily backups, so two missed days is a pattern rather than a hiccup.
const BACKUP_STALE_AFTER_MS = 48 * 60 * 60 * 1000;
const LAST_BACKUP_KEY = 'offsite_backup_at';

/**
 * Notices an off-site backup that has quietly stopped happening.
 *
 * Silent failure is the standard way backups go wrong: a cron job that stops
 * firing produces no output, and an absence of log lines is not something
 * anybody notices. deploy/offsite-backup.sh records each success here through
 * the bot, and the bot is the only thing that is always running, so this is the
 * one place the absence can be turned into a message.
 *
 * Only warns once a backup has succeeded at least once. Before that, nobody has
 * configured it yet and a warning every hour would be noise they learn to
 * ignore — which is how a real one gets missed later.
 */
function warnIfBackupsAreStale() {
  const stored = Number(getAppState(LAST_BACKUP_KEY));
  if (!Number.isFinite(stored) || stored <= 0) return;

  const since = Date.now() - stored;
  if (since > BACKUP_STALE_AFTER_MS) {
    logger.warn('No off-site backup has succeeded in over 48 hours', {
      hoursSinceLastBackup: Math.round(since / 3600000),
      lastBackupAt: new Date(stored).toISOString(),
    });
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

    warnIfBackupsAreStale();
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
        await runExpiryReminders();
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
  runExpiryReminders,
  runRetentionSweep,
  startRetentionSweeps,
  warnIfBackupsAreStale,
};
