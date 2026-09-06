const config = require('../config');
const logger = require('../utils/logger');
const {
  getAiUsageToday,
  recordAiCompletion,
  markAiWarned,
  addAiExtraAllowance,
  resetAiUsageToday,
} = require('./database');

/**
 * A ceiling on what the AI can cost in a day.
 *
 * Per-user limits already exist — three summaries a day on free, unlimited on
 * premium — but nothing bounded the TOTAL. A traffic spike, a bug that defeats
 * the digest cache, or somebody farming free accounts all turn into an uncapped
 * bill with no alert and no brake. At roughly RUB 0.10 a summary this is a tail
 * risk rather than a daily concern, but the tail is the part with no end.
 *
 * Off by default, deliberately. A cap nobody has thought about is worse than no
 * cap: it stops the product working at a number nobody chose.
 */

class SpendCapReachedError extends Error {
  constructor(usage, limit) {
    super(`Daily DeepSeek completion cap reached (${usage}/${limit})`);
    this.name = 'SpendCapReachedError';
    this.usage = usage;
    this.limit = limit;
  }
}

// Set once at startup by bot.js. Left as a no-op so nothing here depends on
// Telegram: this module is imported by deepseek.js, which must not drag a bot
// client into every test that stubs a summary.
let notifyAdmins = null;

function setAdminNotifier(fn) {
  notifyAdmins = fn;
}

/** The hard ceiling in force right now, including anything an admin added today. */
function hardLimitToday(usage = getAiUsageToday()) {
  if (!config.deepseek.dailyMaxCompletions) return null;
  return config.deepseek.dailyMaxCompletions + (usage.extra_allowance || 0);
}

/**
 * Refuses the call rather than making it.
 *
 * Checked before the request, not after, because the point is not to spend the
 * money. Throws a named error so callers can tell "we chose not to" apart from
 * "DeepSeek is broken" and say something honest about it.
 */
function assertWithinBudget() {
  const usage = getAiUsageToday();
  const limit = hardLimitToday(usage);
  if (limit !== null && usage.completions >= limit) {
    throw new SpendCapReachedError(usage.completions, limit);
  }
}

/**
 * Books one completion, and warns the operator the first time the day crosses
 * the warn threshold.
 *
 * Once per day, not once per call: the warning exists to be noticed, and a DM
 * on every subsequent summary is a thing people mute.
 */
function recordCompletion({ promptTokens = 0, completionTokens = 0 } = {}) {
  const usage = recordAiCompletion({ promptTokens, completionTokens });

  const warnAt = config.deepseek.dailyWarnCompletions;
  if (!warnAt || usage.completions < warnAt || usage.warned_at) return usage;

  markAiWarned();
  const limit = hardLimitToday(usage);
  logger.warn('DeepSeek daily completions passed the warning threshold', {
    completions: usage.completions,
    warnAt,
    hardLimit: limit,
  });

  if (notifyAdmins) {
    Promise.resolve(
      notifyAdmins(
        `⚠️ DeepSeek: ${usage.completions} completions today (warning at ${warnAt}` +
          `${limit !== null ? `, hard stop at ${limit}` : ', no hard cap set'}).\n` +
          `Tokens: ${usage.prompt_tokens} in, ${usage.completion_tokens} out.\n` +
          'Use /spend to see the detail, /spend allow <n> to add room for today.'
      )
      // Telling the admin is best effort. Failing to warn must never be the
      // thing that stops a summary the user asked for.
    ).catch((error) => logger.error('Could not DM the spend warning', { error: error.message }));
  }

  return usage;
}

function describeBudget() {
  const usage = getAiUsageToday();
  return {
    completions: usage.completions,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    extraAllowance: usage.extra_allowance,
    warnAt: config.deepseek.dailyWarnCompletions || null,
    hardLimit: hardLimitToday(usage),
    blocked: hardLimitToday(usage) !== null && usage.completions >= hardLimitToday(usage),
  };
}

module.exports = {
  SpendCapReachedError,
  setAdminNotifier,
  assertWithinBudget,
  recordCompletion,
  describeBudget,
  addExtraAllowance: addAiExtraAllowance,
  resetToday: resetAiUsageToday,
};
