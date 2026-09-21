const logger = require('../utils/logger');
const {
  logEvent,
  getEventCounts,
  getDistinctEventUsers,
  getRetentionCurve,
  getWeeklyCohorts,
  getDailyActiveUsers,
} = require('./database');

const EVENTS = {
  USER_STARTED: 'user_started',
  HELP_VIEWED: 'help_viewed',
  CHAT_LINKED: 'chat_linked',
  SUMMARY_REQUESTED: 'summary_requested',
  SUMMARY_COMPLETED: 'summary_completed',
  SUMMARY_BLOCKED_DAILY_LIMIT: 'summary_blocked_daily_limit',
  SUMMARY_BLOCKED_GROUP_LIMIT: 'summary_blocked_group_limit',
  SUMMARY_WEEK_BLOCKED_PREMIUM: 'summary_week_blocked_premium',
  FIND_REQUESTED: 'find_requested',
  FIND_BLOCKED_GROUP_LIMIT: 'find_blocked_group_limit',
  FIND_NO_RESULTS: 'find_no_results',
  DIGEST_BLOCKED_PREMIUM: 'digest_blocked_premium',
  CHANNEL_ADDED: 'channel_added',
  CHANNEL_REMOVED: 'channel_removed',
  CHANNEL_BLOCKED_PREMIUM: 'channel_blocked_premium',
  CHANNEL_BLOCKED_LIMIT: 'channel_blocked_limit',
  // Topic categories are free and cost nothing to match, so the only open
  // question about them is whether anyone uses them at all: they overlap with
  // the theme headings every summary already writes. Measured before changed.
  FILTER_CATEGORY_TOGGLED: 'filter_category_toggled',
  FILTER_KEYWORDS_ADDED: 'filter_keywords_added',
  FILTER_KEYWORDS_REMOVED: 'filter_keywords_removed',
  FILTER_BLOCKED_PREMIUM: 'filter_blocked_premium',
  FILTER_BLOCKED_LIMIT: 'filter_blocked_limit',
  DIGEST_CONFIGURED: 'digest_configured',
  SCHEDULED_DIGEST_SENT: 'scheduled_digest_sent',
  // Several sources due in the same hour, delivered as one DM. sourceCount in
  // the metadata; scheduled_digest_sent is still recorded once per source.
  DIGEST_BUNDLE_SENT: 'digest_bundle_sent',
  // Churn of a kind that is otherwise invisible: someone blocked the bot, so
  // their digest was switched off rather than retried daily for ever.
  DIGEST_DISABLED_BLOCKED: 'digest_disabled_blocked',
  ALERT_SENT: 'alert_sent',
  BROADCAST_SENT: 'broadcast_sent',
  STATUS_VIEWED: 'status_viewed',
  SUBSCRIBE_VIEWED: 'subscribe_viewed',
  // The two halves of the reminder funnel: how many nudges went out, and how
  // many renewals followed one closely enough to credit it.
  REMINDER_SENT: 'reminder_sent',
  RENEWED_AFTER_REMINDER: 'renewed_after_reminder',
  TRIAL_STARTED: 'trial_started',
  // Someone who arrived through the link under a group summary. chatId is the
  // group it came from, so the channel is measurable per group. It grants
  // nothing: a reward would only pay people to refer their own second account.
  REFERRAL_STARTED: 'referral_started',
  SUBSCRIPTION_PURCHASED: 'subscription_purchased',
};

// Events that represent a user hitting a free-plan wall — the moments most
// likely to precede a purchase. Used to compute the paywall -> purchase
// conversion rate, the single most actionable number for pricing/limit tuning.
const PAYWALL_EVENTS = [
  EVENTS.SUMMARY_BLOCKED_DAILY_LIMIT,
  EVENTS.SUMMARY_BLOCKED_GROUP_LIMIT,
  EVENTS.SUMMARY_WEEK_BLOCKED_PREMIUM,
  EVENTS.FIND_BLOCKED_GROUP_LIMIT,
  EVENTS.DIGEST_BLOCKED_PREMIUM,
  EVENTS.CHANNEL_BLOCKED_PREMIUM,
  EVENTS.FILTER_BLOCKED_PREMIUM,
];

// Analytics must never break the feature it's instrumenting — always swallow
// and log, never throw back into the command handler.
function track(eventType, { userId, chatId, metadata } = {}) {
  try {
    logEvent(eventType, { userId, chatId, metadata });
  } catch (error) {
    logger.error('Failed to record analytics event', { eventType, error: error.message });
  }
}

function getFunnelReport(sinceDays) {
  const counts = getEventCounts(sinceDays);

  const paywallUsers = getDistinctEventUsers(PAYWALL_EVENTS, sinceDays);
  const purchasedUsers = new Set(getDistinctEventUsers([EVENTS.SUBSCRIPTION_PURCHASED], sinceDays));
  const convertedFromPaywall = paywallUsers.filter((id) => purchasedUsers.has(id)).length;

  // The reminder funnel, measured the same way: of the people nudged, how
  // many then paid. This is the number that says whether feature-01 earns its
  // place, so it is computed rather than left to be eyeballed from raw counts.
  const remindedUsers = getDistinctEventUsers([EVENTS.REMINDER_SENT], sinceDays);
  const renewedAfterReminder = remindedUsers.filter((id) => purchasedUsers.has(id)).length;

  // Whether the trial pays for itself, measured the same way as the paywall.
  const trialUsers = getDistinctEventUsers([EVENTS.TRIAL_STARTED], sinceDays);
  const convertedFromTrial = trialUsers.filter((id) => purchasedUsers.has(id)).length;

  // Whether the summary footer brings in people who go on to pay.
  const referredUsers = getDistinctEventUsers([EVENTS.REFERRAL_STARTED], sinceDays);
  const convertedFromReferral = referredUsers.filter((id) => purchasedUsers.has(id)).length;

  return {
    counts,
    paywallHitUsers: paywallUsers.length,
    convertedFromPaywall,
    totalPurchasers: purchasedUsers.size,
    remindedUsers: remindedUsers.length,
    renewedAfterReminder,
    trialUsers: trialUsers.length,
    convertedFromTrial,
    referredUsers: referredUsers.length,
    convertedFromReferral,
  };
}

function getRetentionReport({ cohortWeeks = 6, activeDays = 14 } = {}) {
  return {
    curve: getRetentionCurve([1, 7, 30]),
    cohorts: getWeeklyCohorts(cohortWeeks),
    dailyActive: getDailyActiveUsers(activeDays),
  };
}

module.exports = { EVENTS, track, getFunnelReport, getRetentionReport };
