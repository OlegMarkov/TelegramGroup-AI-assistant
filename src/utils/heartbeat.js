const fs = require('fs');
const path = require('path');

/**
 * Periodically touch a file so Docker's HEALTHCHECK can tell the bot is alive.
 *
 * `isAlive` guards each write. Without it the timer fires regardless of what
 * the bot is actually doing, so a process that has stopped consuming Telegram
 * updates keeps reporting healthy — it looks identical to a working bot that
 * simply has no traffic. When `isAlive` returns false the file stops being
 * refreshed, goes stale, and healthcheck.js reports unhealthy.
 */
function startHeartbeat(filePath, { intervalMs = 30000, isAlive = () => true } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const write = () => {
    if (!isAlive()) return;
    fs.writeFileSync(filePath, String(Date.now()));
  };
  write();

  const timer = setInterval(write, intervalMs);
  timer.unref(); // must not be the thing keeping the process alive

  return () => clearInterval(timer);
}

module.exports = { startHeartbeat };
