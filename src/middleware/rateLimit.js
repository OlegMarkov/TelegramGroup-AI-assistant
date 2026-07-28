const config = require('../config');

const hits = new Map();

function isBotInteraction(ctx) {
  if (ctx.updateType === 'callback_query' || ctx.updateType === 'pre_checkout_query') return true;
  if (ctx.updateType !== 'message') return false;

  const text = ctx.message && ctx.message.text;
  if (text && text.startsWith('/')) return true;

  // In groups, ordinary chatter is passively ingested, not a request to the bot —
  // only DMs and commands should count against the limit.
  return ctx.chat && ctx.chat.type === 'private';
}

function rateLimit({ windowMs = config.rateLimit.windowMs, maxRequests = config.rateLimit.maxRequests } = {}) {
  return async (ctx, next) => {
    const userId = ctx.from && ctx.from.id;
    if (!userId) return next();
    if (!isBotInteraction(ctx)) return next();

    const now = Date.now();
    const entry = hits.get(userId) || { count: 0, resetAt: now + windowMs };

    if (now > entry.resetAt) {
      entry.count = 0;
      entry.resetAt = now + windowMs;
    }

    entry.count += 1;
    hits.set(userId, entry);

    if (entry.count > maxRequests) {
      const retryInSeconds = Math.ceil((entry.resetAt - now) / 1000);
      return ctx.reply(`Too many requests. Please try again in ${retryInSeconds}s.`);
    }

    return next();
  };
}

module.exports = rateLimit;
