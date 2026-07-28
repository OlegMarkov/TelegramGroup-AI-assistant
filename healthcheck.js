const fs = require('fs');
const path = require('path');

const databasePath = process.env.DATABASE_PATH || './data/bot.db';
const heartbeatFile = path.join(path.dirname(databasePath), 'heartbeat');
const maxAgeMs = Number(process.env.HEARTBEAT_MAX_AGE_MS) || 90000;

try {
  const stat = fs.statSync(heartbeatFile);
  const age = Date.now() - stat.mtimeMs;
  if (age > maxAgeMs) {
    console.error(`Heartbeat stale: ${Math.round(age / 1000)}s old (max ${Math.round(maxAgeMs / 1000)}s)`);
    process.exit(1);
  }
  process.exit(0);
} catch (error) {
  console.error(`Heartbeat unavailable: ${error.message}`);
  process.exit(1);
}
