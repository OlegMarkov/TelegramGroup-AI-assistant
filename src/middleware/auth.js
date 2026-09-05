const { getOrCreateUser, getActiveSubscription } = require('../services/database');
const { normalizeLanguage } = require('../utils/i18n');

function auth() {
  return async (ctx, next) => {
    if (!ctx.from) return next();

    // Seed new users from their Telegram client language so the very first
    // reply is already localized, before they've touched /language.
    const clientLanguage = normalizeLanguage(ctx.from.language_code);

    // Telegram omits `username` entirely for a user who has none, and
    // getOrCreateUser reads undefined as "I do not know this field" so that
    // callers passing an id alone cannot erase a name. Here we do know: null
    // says the handle is genuinely gone, so dropping one is recorded rather
    // than leaving the old value behind for ever.
    const user = getOrCreateUser({
      id: ctx.from.id,
      username: ctx.from.username ?? null,
      firstName: ctx.from.first_name ?? null,
      language: clientLanguage,
    });

    ctx.state.user = user;
    ctx.state.lang = normalizeLanguage(user.language || clientLanguage);
    ctx.state.subscription = getActiveSubscription(ctx.from.id) || null;

    return next();
  };
}

module.exports = auth;
