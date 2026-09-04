const logger = require('./logger');

/**
 * Sending to many people at once, without Telegram throwing most of it away.
 *
 * The scheduler loops over every due digest and sends immediately. Telegram
 * starts answering 429 at roughly 30 messages a second, and because everyone
 * picks from the same four UTC hours, subscribers cluster: at a few hundred
 * users a single tick tries to send hundreds of DMs back to back. The failures
 * were caught and logged per digest, so nothing crashed — those people simply
 * did not get their digest, and nothing retried.
 *
 * Lives in its own module because the admin broadcast will hit this same wall
 * far harder, and the throttle should be solved once rather than twice.
 */

// Well under Telegram's ~30/sec. The headroom is not politeness: on-demand
// /summary traffic shares the same bot token, is not counted here, and does
// not stop while a tick is running.
const DEFAULT_SENDS_PER_SECOND = 20;

const MAX_ATTEMPTS = 3;

// A 429 can name a retry_after of several minutes. Waiting one out is right;
// blocking an hourly tick for the whole hour is not, so give up instead and
// let the next tick try again.
const MAX_RETRY_AFTER_MS = 60_000;

// Long enough to outlast a blip, short enough not to stall the queue behind it.
const TRANSIENT_BACKOFF_MS = 1_000;

function realSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(error) {
  if (!error) return null;
  if (typeof error.code === 'number') return error.code;
  const response = error.response;
  return response && typeof response.error_code === 'number' ? response.error_code : null;
}

function errorText(error) {
  if (!error) return '';
  return String(error.description || error.message || '');
}

/**
 * Has this person put the bot beyond reach for good?
 *
 * Deliberately narrow. A 429 or a dropped connection must never look like this,
 * because the caller's response is to disable the user's digest — doing that
 * for a transient failure silently switches off a feature they paid for.
 */
function isBlockedError(error) {
  if (errorCode(error) === 403) return true;
  return /bot was blocked by the user|user is deactivated|bot was kicked/i.test(errorText(error));
}

function isRateLimitError(error) {
  return errorCode(error) === 429 || /too many requests/i.test(errorText(error));
}

/**
 * Telegram refusing the request as written — which is what an unbalanced * or _
 * from a model or a stranger produces.
 *
 * Callers use this to decide whether resending the same text without
 * parse_mode is worth trying. Narrow on purpose: retrying a dropped connection
 * as plain text throws away the formatting for no reason and burns the one
 * useful retry on the wrong thing.
 */
function isBadRequestError(error) {
  return errorCode(error) === 400;
}

/**
 * Worth trying again shortly: a network blip, or Telegram's own 5xx. A 4xx is
 * a statement about the request and will fail identically on a retry.
 */
function isTransientError(error) {
  const code = errorCode(error);
  if (code === null) return true; // no Telegram response at all — the network
  return code >= 500;
}

function retryAfterMs(error) {
  const parameters = (error && error.parameters) || (error && error.response && error.response.parameters);
  const seconds = parameters && Number(parameters.retry_after);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}

/**
 * A paced, retrying sender. One per run, so the pacing state spans the whole
 * batch rather than resetting per recipient.
 *
 * `sleep` is injectable purely so tests can assert the waits without taking
 * them.
 */
function createSender({ perSecond = DEFAULT_SENDS_PER_SECOND, sleep = realSleep } = {}) {
  const minGapMs = Math.ceil(1000 / perSecond);
  let nextSlotAt = 0;

  async function pace() {
    const now = Date.now();
    const waitMs = nextSlotAt - now;
    // Booked before the await, so concurrent callers queue behind each other
    // instead of all reading the same free slot.
    nextSlotAt = Math.max(now, nextSlotAt) + minGapMs;
    if (waitMs > 0) await sleep(waitMs);
  }

  /**
   * Runs one send, paced, retrying only what a retry could fix.
   *
   * `perform` owns the actual API call, so a caller keeps its own handling of
   * things a retry cannot fix — the digest's Markdown-then-plain-text fallback
   * belongs inside it, not here.
   */
  async function send(perform) {
    for (let attempt = 1; ; attempt++) {
      await pace();

      try {
        return await perform();
      } catch (error) {
        const rateLimited = isRateLimitError(error);
        const worthRetrying = rateLimited || (isTransientError(error) && !isBlockedError(error));

        if (!worthRetrying || attempt >= MAX_ATTEMPTS) throw error;

        const waitMs = rateLimited
          ? Math.min(retryAfterMs(error) || TRANSIENT_BACKOFF_MS, MAX_RETRY_AFTER_MS)
          : TRANSIENT_BACKOFF_MS;

        logger.warn(rateLimited ? 'Telegram rate limited a send; waiting the interval it asked for' : 'Retrying a send after a transient failure', {
          attempt,
          waitMs,
          error: errorText(error),
        });

        await sleep(waitMs);
        // The pause already covers the gap; do not also charge for a slot.
        nextSlotAt = Date.now();
      }
    }
  }

  return { send };
}

module.exports = {
  createSender,
  isBlockedError,
  isRateLimitError,
  isBadRequestError,
  isTransientError,
  retryAfterMs,
  DEFAULT_SENDS_PER_SECOND,
  MAX_ATTEMPTS,
};
