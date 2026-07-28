const { getOrCreateUser, getActiveSubscription } = require('../services/database');
const { normalizeLanguage } = require('../utils/i18n');

function auth() {
  return async (ctx, next) => {
    if (!ctx.from) return next();

    // Seed new users from their Telegram client language so the very first
    // reply is already localized, before they've touched /language.
    const clientLanguage = normalizeLanguage(ctx.from.language_code);

    const user = getOrCreateUser({
      id: ctx.from.id,
      username: ctx.from.username,
      firstName: ctx.from.first_name,
      language: clientLanguage,
    });

    ctx.state.user = user;
    ctx.state.lang = normalizeLanguage(user.language || clientLanguage);
    ctx.state.subscription = getActiveSubscription(ctx.from.id) || null;

    return next();
  };
}

module.exports = auth;
