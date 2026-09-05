const {
  getPausedChatIds,
  getOptedOutUserIds,
  setChatPaused,
  setUserOptedOut,
} = require('./database');

/**
 * "May I store this message?", answered cheaply.
 *
 * This runs on every group message the bot sees, in every group it is in, so it
 * cannot be two indexed lookups per message. Both answers are cached as sets:
 * paused chats and opted-out members are both rare, so the whole of each fits
 * in memory with room to spare, and the common answer — no, nobody here has
 * opted out — costs two Set lookups.
 *
 * The cache is authoritative because every write goes through this module and
 * the bot is a single process. Editing the database by hand underneath a
 * running bot would leave it stale; restarting picks the truth back up.
 */

let pausedChats = null;
let optedOutUsers = null;

function paused() {
  if (!pausedChats) pausedChats = new Set(getPausedChatIds());
  return pausedChats;
}

function optedOut() {
  if (!optedOutUsers) optedOutUsers = new Set(getOptedOutUserIds());
  return optedOutUsers;
}

/**
 * Both checks, in the order that fails fastest for the common case.
 *
 * A member's opt-out applies in every chat, not just the one they asked in.
 * "Keep me out of this" is a statement about them, not about a room.
 */
function mayStoreMessage(chatId, userId) {
  return !paused().has(chatId) && !optedOut().has(userId);
}

function isChatPaused(chatId) {
  return paused().has(chatId);
}

function isOptedOut(userId) {
  return optedOut().has(userId);
}

function pauseChat(chatId, isPaused) {
  setChatPaused(chatId, isPaused);
  if (isPaused) paused().add(chatId);
  else paused().delete(chatId);
}

function optOutUser(userId, isOptedOut) {
  setUserOptedOut(userId, isOptedOut);
  if (isOptedOut) optedOut().add(userId);
  else optedOut().delete(userId);
}

/** Drops both caches, so the next read reloads. For tests, and after a restore. */
function reload() {
  pausedChats = null;
  optedOutUsers = null;
}

module.exports = {
  mayStoreMessage,
  isChatPaused,
  isOptedOut,
  pauseChat,
  optOutUser,
  reload,
};
