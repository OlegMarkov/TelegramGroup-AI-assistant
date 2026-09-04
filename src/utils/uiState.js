const { isMenuButtonText } = require('./i18n');

// Ephemeral per-user state for a screen that is open right now: which rows are
// ticked, and whether we are waiting for an answer to a question we just asked.
//
// Deliberately in memory rather than in the database. None of it is worth
// keeping across a restart — losing it costs the user one extra tap — and
// writing it would mean a row per keystroke of UI.

const PROMPT_TTL_MS = 5 * 60 * 1000;
const SELECTION_TTL_MS = 30 * 60 * 1000;

function sweep(map) {
  const now = Date.now();
  for (const [key, entry] of map) {
    if (entry.expiresAt <= now) map.delete(key);
  }
}

// One pending question per user, not one per feature: a person is only ever
// answering the last thing they were asked. Tapping "add a channel" and then
// "add a keyword" must leave the keyword prompt waiting, not both.
const prompts = new Map(); // userId -> { kind, expiresAt }

function armPrompt(userId, kind) {
  sweep(prompts);
  prompts.set(userId, { kind, expiresAt: Date.now() + PROMPT_TTL_MS });
}

/** Drops the pending question, but only if it is still the one `kind` asked. */
function clearPrompt(userId, kind) {
  const entry = prompts.get(userId);
  if (entry && (!kind || entry.kind === kind)) prompts.delete(userId);
}

/** Consumes the pending flag: a captured message is only ever answered once. */
function takePrompt(userId, kind) {
  const entry = prompts.get(userId);
  if (!entry || entry.kind !== kind) return false;
  prompts.delete(userId);
  return entry.expiresAt > Date.now();
}

/**
 * Middleware that hands the next plain message to `handler` when the user is
 * answering this kind of prompt, and passes everything else through.
 *
 * The pass-through is the important half. These handlers sit ahead of the ones
 * registered by later command modules, so anything that looks like a command
 * or a menu-button label — in any language, since a user who switched language
 * still has the old keyboard rendered — has to keep flowing. Otherwise tapping
 * ⭐ Subscribe at a prompt would try to follow a channel called "Subscribe".
 *
 * Private chats only: in a group the next message is somebody talking.
 */
function captureReply(kind, handler) {
  return async (ctx, next) => {
    const text = ctx.message && ctx.message.text;
    if (!text || !ctx.chat || ctx.chat.type !== 'private' || !ctx.from) return next();
    if (text.startsWith('/') || isMenuButtonText(text)) return next();
    if (!takePrompt(ctx.from.id, kind)) return next();
    return handler(ctx, text.trim());
  };
}

/**
 * A per-user set of ticked rows, for keyboards where you select several things
 * and then act on them at once.
 *
 * Values are whatever identifies a row to its own feature — a chat id, a
 * keyword hash — and callers are expected to drop entries that no longer
 * exist when they redraw, since the underlying list can change between two
 * taps of the same keyboard.
 */
function createSelectionStore(ttlMs = SELECTION_TTL_MS) {
  const store = new Map(); // userId -> { values: Set, expiresAt }

  return {
    get(userId) {
      const entry = store.get(userId);
      if (!entry || entry.expiresAt <= Date.now()) {
        store.delete(userId);
        return new Set();
      }
      return entry.values;
    },
    set(userId, values) {
      sweep(store);
      if (values.size === 0) store.delete(userId);
      else store.set(userId, { values, expiresAt: Date.now() + ttlMs });
    },
    clear(userId) {
      store.delete(userId);
    },
  };
}

module.exports = {
  armPrompt,
  clearPrompt,
  takePrompt,
  captureReply,
  createSelectionStore,
  PROMPT_TTL_MS,
};
