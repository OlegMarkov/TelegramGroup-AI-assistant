require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value && process.env.NODE_ENV !== 'test') {
    // eslint-disable-next-line no-console
    console.warn(`[config] Missing environment variable: ${name}`);
  }
  return value;
}

module.exports = {
  botToken: required('BOT_TOKEN'),

  deepseek: {
    apiKey: required('DEEPSEEK_API_KEY'),
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
  },

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
  },

  database: {
    path: process.env.DATABASE_PATH || './data/bot.db',
  },

  logLevel: process.env.LOG_LEVEL || 'info',
  env: process.env.NODE_ENV || 'development',

  rateLimit: {
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 10000,
    maxRequests: Number(process.env.RATE_LIMIT_MAX_REQUESTS) || 10,
  },

  adminUserIds: (process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n)),

  privacy: {
    // Stored group messages are deleted after this many days. Summaries only
    // ever look back 72h, so this window exists purely to keep /find useful —
    // it is the main lever on how much of other people's conversation the bot
    // retains, so keep it as short as the product can tolerate.
    messageRetentionDays: Number(process.env.MESSAGE_RETENTION_DAYS) || 90,
    // Grace period after the bot is removed from a group before that chat's
    // messages are purged. Non-zero so an accidental removal is recoverable.
    purgeAfterRemovalDays: Number(process.env.PURGE_AFTER_REMOVAL_DAYS) || 7,
  },
};
