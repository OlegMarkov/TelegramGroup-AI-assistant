const fs = require('fs');
const path = require('path');

function startHeartbeat(filePath, intervalMs = 30000) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const write = () => fs.writeFileSync(filePath, String(Date.now()));
  write();

  const timer = setInterval(write, intervalMs);
  timer.unref(); // must not be the thing keeping the process alive

  return () => clearInterval(timer);
}

module.exports = { startHeartbeat };
