const config = require('../config');
const logger = require('../utils/logger');
const {
  getAlertSubscribers,
  getUserFilters,
  getActiveSubscription,
  isUserLinkedToChat,
  getChatById,
  getUserLanguage,
  takeAlertSlot,
} = require('./database');
const { buildFilterMatcher } = require('./filterMatcher');
const { allowedKeywords } = require('../models/filter');
const { getLimits } = require('../models/subscription');
const { escapeMarkdown, truncate } = require('../utils/formatters');
const { t, normalizeLanguage } = require('../utils/i18n');
const { createSender, isBlockedError, isBadRequestError } = require('../utils/telegramSend');
const { track, EVENTS } = require('./analytics');

/**
 * Telling someone their keyword just came up, without asking them to ask.
 *
 * This changes what the bot is: from something you ask, to something that
 * messages you. Everything here is shaped by that — it is opt-in, off by
 * default, premium-only, one tap to switch off, and capped so that one busy
 * keyword cannot turn into a hundred DMs an hour. Get that wrong and it reads
 * as spam and costs the user entirely, which is a worse outcome than the
 * feature not existing.
 */

// One busy keyword in an active group can fire continuously. Past this many in
// an hour the alerts stop being useful and start being noise, so we say so once
// and go quiet until the hour rolls over.
const MAX_ALERTS_PER_HOUR = 10;

const QUOTE_CHARS = 280;

/**
 * Who wants alerts at all, cached.
 *
 * The naive shape of this feature is O(members × keywords) on every group
 * message: for each member, load their filters and test them. That is work on
 * the hot path of every message in every group, almost all of it to conclude
 * that nobody wanted anything.
 *
 * The cheap answer is not a queue, it is arithmetic: alerts are opt-in AND
 * premium, so the set of people who want them is small and usually empty. This
 * cache is the whole set; the common case costs one Set lookup and returns.
 * A BullMQ job would move the same work off the request path while adding a
 * dependency on Redis being up for a paid feature to work at all — worth it if
 * the work were unavoidable, and it is not.
 *
 * Authoritative because every write goes through this module and the bot is one
 * process, exactly like ingestionPolicy.
 */
let subscribers = null;

function subscriberIds() {
  if (!subscribers) subscribers = new Set(getAlertSubscribers());
  return subscribers;
}

function setSubscribed(userId, enabled) {
  if (enabled) subscriberIds().add(userId);
  else subscriberIds().delete(userId);
}

function isSubscribed(userId) {
  return subscriberIds().has(userId);
}

function reload() {
  subscribers = null;
}

// Set at startup by bot.js, for the same reason aiBudget's notifier is: this
// module is reached from ingestion middleware, and importing a bot client here
// would put one into every test that sends a group message.
let sendMessage = null;

function setAlertSender(fn) {
  sendMessage = fn;
}

/**
 * A link back to the message that matched.
 *
 * A public group has a username and a public permalink. A private supergroup
 * has neither, but t.me/c/<id>/<message> works for anyone already in the chat —
 * which the recipient is, since we only alert members. Anything else (a legacy
 * group, an id that is not a supergroup) gets no link rather than a broken one.
 */
function messageLink(chat, messageId) {
  if (!chat || !messageId) return null;
  if (chat.username) return `https://t.me/${chat.username}/${messageId}`;
  const id = String(chat.id);
  return id.startsWith('-100') ? `https://t.me/c/${id.slice(4)}/${messageId}` : null;
}

/**
 * The keywords that actually match for this person right now.
 *
 * allowedKeywords is applied here, on the way out, for exactly the reason
 * digest.js applies it there: a subscription can lapse between adding a keyword
 * and a message arriving, and the gate has to be at the point where a stored
 * filter turns into a match. Categories are deliberately not included — a
 * topic like "Tech" would fire on half a technical group.
 */
function liveMatcherFor(userId) {
  const subscription = getActiveSubscription(userId);
  const limits = getLimits(subscription);

  // Premium-gated. A lapsed subscriber keeps their keywords and their opt-in,
  // and simply stops being alerted until they renew.
  if (!limits.scheduledDigests) return null;

  const { keywords } = getUserFilters(userId);
  const live = allowedKeywords(keywords, limits.maxKeywords);
  if (live.length === 0) return null;

  return buildFilterMatcher({ keywords: live, categories: [] });
}

async function deliver(userId, text, extra) {
  const sender = createSender();
  return sender.send(async () => {
    try {
      await sendMessage(userId, text, { parse_mode: 'Markdown', ...extra });
    } catch (error) {
      // Only a 400 means "I could not parse that". The quoted text is written
      // by a stranger, so an unbalanced marker is always possible even after
      // escaping — delivering it unformatted beats not delivering it.
      if (!isBadRequestError(error)) throw error;
      await sendMessage(userId, text, extra);
    }
  });
}

/**
 * Called for every stored group message. Returns the number of alerts sent, so
 * tests can assert on it; callers ignore it.
 */
async function alertOnMessage({ chat, messageId, authorId, authorName, text }) {
  if (!sendMessage || !text || !chat) return 0;

  // The common case, and the reason this is affordable: nobody here wants
  // alerts, so we are done after one Set lookup.
  if (subscriberIds().size === 0) return 0;

  let sent = 0;

  for (const userId of subscriberIds()) {
    // Never about your own message — you were there when you wrote it.
    if (userId === authorId) continue;
    if (!isUserLinkedToChat(chat.id, userId)) continue;

    const matches = liveMatcherFor(userId);
    if (!matches || !matches(text)) continue;

    const slot = takeAlertSlot(userId, MAX_ALERTS_PER_HOUR);
    // Past the cap and already told: stay quiet for the rest of the hour.
    if (slot === 'suppressed') continue;

    const lang = normalizeLanguage(getUserLanguage(userId));

    try {
      if (slot === 'muted') {
        // The one message that says why the others are not coming.
        await deliver(userId, t(lang, 'alerts.muted', { max: MAX_ALERTS_PER_HOUR }));
        continue;
      }

      const link = messageLink(chat, messageId);
      const body = t(lang, 'alerts.match', {
        chat: escapeMarkdown(chat.title || t(lang, 'common.chatFallback', { id: chat.id })),
        author: escapeMarkdown(authorName || t(lang, 'find.unknownAuthor')),
        // Attacker-written text reaching Telegram's parser, same as the digest
        // highlights and /find results.
        text: escapeMarkdown(truncate(text, QUOTE_CHARS)),
      });

      await deliver(
        userId,
        body,
        link ? { reply_markup: { inline_keyboard: [[{ text: t(lang, 'alerts.openButton'), url: link }]] } } : {}
      );

      track(EVENTS.ALERT_SENT, { userId, chatId: chat.id });
      sent += 1;
    } catch (error) {
      if (isBlockedError(error)) {
        // They blocked the bot. Switching their alerts off is the same
        // reasoning as case-11: retrying for ever is unbounded waste.
        setSubscribed(userId, false);
        require('./database').setUserAlertsEnabled(userId, false);
        logger.info('Disabled keyword alerts for a user who blocked the bot', { userId });
        continue;
      }
      logger.warn('Keyword alert failed', { userId, chatId: chat.id, error: error.message });
    }
  }

  return sent;
}

/**
 * Fire and forget, deliberately.
 *
 * This runs from ingestion middleware, which must hand the update on
 * immediately: awaiting a DM here would put a Telegram round trip in front of
 * every group message. A failed alert is logged and dropped rather than
 * retried — it is a notification, and a late one is worth less than the next
 * one being on time.
 */
function alertOnMessageInBackground(payload) {
  Promise.resolve()
    .then(() => alertOnMessage(payload))
    .catch((error) => logger.error('Keyword alerting failed', { error: error.message }));
}

module.exports = {
  alertOnMessage,
  alertOnMessageInBackground,
  setAlertSender,
  setSubscribed,
  isSubscribed,
  reload,
  messageLink,
  MAX_ALERTS_PER_HOUR,
  // Exported so /filter can gate the toggle the same way everything else does.
  isAlertsAvailable: (subscription) => getLimits(subscription).scheduledDigests,
  adminIds: config.adminUserIds,
};
