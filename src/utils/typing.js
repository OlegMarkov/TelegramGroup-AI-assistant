const logger = require('./logger');

// Telegram clears a chat action after about five seconds, so a single call
// covers only the first moment of a wait that routinely runs 25 seconds. The
// indicator has to be refreshed to stay visible for the whole operation.
const TYPING_REFRESH_MS = 4000;

/**
 * Shows "typing…" until the returned stop function is called.
 *
 * Two properties matter more than the feature itself:
 *
 * - It can never break what it decorates. A failed chat action is cosmetic;
 *   losing the summary because the decoration threw would not be. Every send
 *   is fire-and-forget with errors swallowed.
 * - It must always stop. The caller is responsible for that via `finally`, and
 *   the timer is unref'd so a leaked one still cannot hold the process open at
 *   shutdown.
 */
function startTyping(ctx, { action = 'typing', intervalMs = TYPING_REFRESH_MS } = {}) {
  if (!ctx || typeof ctx.sendChatAction !== 'function') return () => {};

  let stopped = false;

  const send = () => {
    if (stopped) return;
    try {
      Promise.resolve(ctx.sendChatAction(action)).catch((error) => {
        logger.debug('Chat action failed', { error: error.message });
      });
    } catch (error) {
      logger.debug('Chat action threw synchronously', { error: error.message });
    }
  };

  send();
  const timer = setInterval(send, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

module.exports = { startTyping, TYPING_REFRESH_MS };
