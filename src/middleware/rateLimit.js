const config = require('../config');
const { getUserLanguage } = require('../services/database');
const { t, normalizeLanguage } = require('../utils/i18n');

const hits = new Map();

// Entries are only ever added, one per user id, and a window that has elapsed
// leaves nothing worth keeping — so without a sweep this map is a slow leak
// that grows with every person who has ever touched the bot.
//
// Swept on write past a threshold rather than on a timer: it costs nothing
// while the bot is idle, needs no handle to unref at shutdown, and there is
// nothing to clean up in a test that never reaches the threshold.
const SWEEP_THRESHOLD = 1000;

function sweep(now) {
  for (const [userId, entry] of hits) {
    if (now > entry.resetAt) hits.delete(userId);
  }
}

function isBotInteraction(ctx) {
  if (ctx.updateType === 'callback_query' || ctx.updateType === 'pre_checkout_query') return true;
  if (ctx.updateType !== 'message') return false;

  const text = ctx.message && ctx.message.text;
  if (text && text.startsWith('/')) return true;

  // In groups, ordinary chatter is passively ingested, not a request to the bot —
  // only DMs and commands should count against the limit.
  return ctx.chat && ctx.chat.type === 'private';
}

/**
 * The language to refuse someone in.
 *
 * This middleware runs ahead of auth(), which is where ctx.state.lang is
 * normally set — deliberately, so a flood costs no database work per update.
 * The rejection itself is rare, so it can afford the one read it takes to
 * honour a /language override; the client's own language_code is the fallback
 * for someone who has never spoken to us before.
 */
function replyLanguage(ctx) {
  if (ctx.state && ctx.state.lang) return ctx.state.lang;
  try {
    return normalizeLanguage(getUserLanguage(ctx.from.id) || ctx.from.language_code);
  } catch {
    return normalizeLanguage(ctx.from.language_code);
  }
}

function rateLimit({
  windowMs = config.rateLimit.windowMs,
  maxRequests = config.rateLimit.maxRequests,
  sweepThreshold = SWEEP_THRESHOLD,
} = {}) {
  return async (ctx, next) => {
    const userId = ctx.from && ctx.from.id;
    if (!userId) return next();
    if (!isBotInteraction(ctx)) return next();

    const now = Date.now();
    if (hits.size >= sweepThreshold) sweep(now);

    const entry = hits.get(userId) || { count: 0, resetAt: now + windowMs };

    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + windowMs;
    }

    entry.count += 1;
    hits.set(userId, entry);

    if (entry.count > maxRequests) {
      const retryInSeconds = Math.ceil((entry.resetAt - now) / 1000);
      return ctx.reply(t(replyLanguage(ctx), 'common.tooManyRequests', { seconds: retryInSeconds }));
    }

    return next();
  };
}

module.exports = rateLimit;
// The tracking map is shared process-wide, so the tests need to see it to
// assert that it does not grow without bound.
module.exports.trackedUsers = hits;
module.exports.SWEEP_THRESHOLD = SWEEP_THRESHOLD;
