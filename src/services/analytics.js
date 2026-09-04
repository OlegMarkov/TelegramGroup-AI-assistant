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
  CHAT_LINKED: 'chat_linked',
  SUMMARY_REQUESTED: 'summary_requested',
  SUMMARY_COMPLETED: 'summary_completed',
  SUMMARY_BLOCKED_DAILY_LIMIT: 'summary_blocked_daily_limit',
  SUMMARY_BLOCKED_GROUP_LIMIT: 'summary_blocked_group_limit',
  FIND_REQUESTED: 'find_requested',
  FIND_BLOCKED_GROUP_LIMIT: 'find_blocked_group_limit',
  DIGEST_BLOCKED_PREMIUM: 'digest_blocked_premium',
  CHANNEL_ADDED: 'channel_added',
  CHANNEL_REMOVED: 'channel_removed',
  CHANNEL_BLOCKED_PREMIUM: 'channel_blocked_premium',
  CHANNEL_BLOCKED_LIMIT: 'channel_blocked_limit',
  FILTER_KEYWORDS_ADDED: 'filter_keywords_added',
  FILTER_KEYWORDS_REMOVED: 'filter_keywords_removed',
  DIGEST_CONFIGURED: 'digest_configured',
  SCHEDULED_DIGEST_SENT: 'scheduled_digest_sent',
  SUBSCRIBE_VIEWED: 'subscribe_viewed',
  SUBSCRIPTION_PURCHASED: 'subscription_purchased',
};

// Events that represent a user hitting a free-plan wall — the moments most
// likely to precede a purchase. Used to compute the paywall -> purchase
// conversion rate, the single most actionable number for pricing/limit tuning.
const PAYWALL_EVENTS = [
  EVENTS.SUMMARY_BLOCKED_DAILY_LIMIT,
  EVENTS.SUMMARY_BLOCKED_GROUP_LIMIT,
  EVENTS.FIND_BLOCKED_GROUP_LIMIT,
  EVENTS.DIGEST_BLOCKED_PREMIUM,
  EVENTS.CHANNEL_BLOCKED_PREMIUM,
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

  return {
    counts,
    paywallHitUsers: paywallUsers.length,
    convertedFromPaywall,
    totalPurchasers: purchasedUsers.size,
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
