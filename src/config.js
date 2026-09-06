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
    // Generation time scales with how much the model writes, and a channel
    // digest is a long answer. Measured from the production VPS: 19s for a
    // 16-post channel (1819 tokens out), 25s for 46 posts (2165 tokens). The
    // old 30s ceiling left about five seconds of headroom and cost the whole
    // summary whenever a day ran long, so this is sized for the worst case
    // rather than the average.
    timeoutMs: Number(process.env.DEEPSEEK_TIMEOUT_MS) || 120000,

    // A ceiling on completions per UTC day, across everybody. Per-user limits
    // exist (3 summaries a day on free, unlimited on premium) but nothing
    // bounded the total: a traffic spike, a bug that defeats the digest cache,
    // or someone farming free accounts all turn into an uncapped bill with no
    // alert and no brake.
    //
    // Both optional and both off by default. A cap somebody has not thought
    // about is worse than none — it stops the product working at a number
    // nobody chose. Counted in completions rather than tokens because that is
    // the unit an operator can actually reason about; tokens are recorded and
    // reported so the two can be calibrated against each other.
    dailyWarnCompletions: Number(process.env.DEEPSEEK_DAILY_WARN_COMPLETIONS) || 0,
    dailyMaxCompletions: Number(process.env.DEEPSEEK_DAILY_MAX_COMPLETIONS) || 0,
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
