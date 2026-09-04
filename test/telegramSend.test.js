const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSender,
  isBlockedError,
  isRateLimitError,
  isBadRequestError,
  isTransientError,
  retryAfterMs,
  MAX_ATTEMPTS,
} = require('../src/utils/telegramSend');

function telegramError(code, description, parameters) {
  const error = new Error(`${code}: ${description}`);
  error.response = { error_code: code, description, parameters };
  error.code = code;
  error.description = description;
  error.parameters = parameters;
  return error;
}

// A sender wired to a clock the test controls, so pacing can be asserted
// exactly rather than raced against however long the machine took.
function testSender(perSecond = 20) {
  let now = 1_000_000;
  const waits = [];
  const realNow = Date.now;
  Date.now = () => now;

  const sender = createSender({
    perSecond,
    sleep: async (ms) => {
      waits.push(ms);
      now += ms; // sleeping really does advance the clock
    },
  });

  return { sender, waits, tick: (ms) => { now += ms; }, restore: () => { Date.now = realNow; } };
}

test('classification keeps a transient failure apart from a permanent one', () => {
  // The whole point: the caller's response to "blocked" is to switch off a
  // feature someone paid for, so a rate limit or a dropped connection must
  // never be mistaken for it.
  const blocked = telegramError(403, 'Forbidden: bot was blocked by the user');
  const limited = telegramError(429, 'Too Many Requests: retry after 5', { retry_after: 5 });
  const badMarkdown = telegramError(400, "Bad Request: can't parse entities");
  const serverSide = telegramError(500, 'Internal Server Error');
  const network = new Error('socket hang up');

  assert.ok(isBlockedError(blocked));
  for (const other of [limited, badMarkdown, serverSide, network]) {
    assert.equal(isBlockedError(other), false, `${other.message} must not read as blocked`);
  }

  assert.ok(isRateLimitError(limited));
  assert.equal(isRateLimitError(network), false);

  assert.ok(isBadRequestError(badMarkdown));
  assert.equal(isBadRequestError(blocked), false);

  assert.ok(isTransientError(network), 'no Telegram response at all is the network');
  assert.ok(isTransientError(serverSide));
  assert.equal(isTransientError(blocked), false, 'a 4xx will fail identically on a retry');

  assert.equal(retryAfterMs(limited), 5000);
  assert.equal(retryAfterMs(network), null);
});

test('sends are paced to the configured rate', async () => {
  const { sender, waits, restore } = testSender(20); // 20/sec — a 50ms gap
  try {
    for (let i = 0; i < 4; i++) await sender.send(async () => 'ok');
  } finally {
    restore();
  }

  // The first send takes the slot that is already free; the rest queue behind.
  assert.deepEqual(waits, [50, 50, 50]);
});

test('a slow caller is not made to wait — pacing is a ceiling, not a metronome', async () => {
  const { sender, waits, tick, restore } = testSender(20);
  try {
    await sender.send(async () => 'ok');
    tick(500); // the caller spent half a second doing its own work
    await sender.send(async () => 'ok');
  } finally {
    restore();
  }

  assert.deepEqual(waits, [], 'nothing was sent too fast, so nothing was delayed');
});

test('a 429 is waited out for exactly as long as Telegram asked', async () => {
  const { sender, waits, restore } = testSender();
  let attempts = 0;
  try {
    const result = await sender.send(async () => {
      attempts += 1;
      if (attempts === 1) throw telegramError(429, 'Too Many Requests: retry after 3', { retry_after: 3 });
      return 'delivered';
    });
    assert.equal(result, 'delivered');
  } finally {
    restore();
  }

  assert.equal(attempts, 2);
  assert.ok(waits.includes(3000), `expected a 3s wait, got ${JSON.stringify(waits)}`);
});

test('a retry_after longer than the tick is refused rather than waited out', async () => {
  // An hourly tick must not sit for the whole hour on one recipient. Giving up
  // leaves the digest unmarked, so the next tick picks it up again.
  const { sender, waits, restore } = testSender();
  try {
    await assert.rejects(
      sender.send(async () => {
        throw telegramError(429, 'Too Many Requests: retry after 900', { retry_after: 900 });
      })
    );
  } finally {
    restore();
  }

  assert.ok(waits.every((ms) => ms <= 60_000), `no wait should exceed a minute, got ${JSON.stringify(waits)}`);
});

test('retries are bounded, and a permanent failure is not retried at all', async () => {
  const { sender, restore } = testSender();
  let limited = 0;
  let blocked = 0;

  try {
    await assert.rejects(
      sender.send(async () => {
        limited += 1;
        throw telegramError(429, 'Too Many Requests: retry after 1', { retry_after: 1 });
      })
    );

    await assert.rejects(
      sender.send(async () => {
        blocked += 1;
        throw telegramError(403, 'Forbidden: bot was blocked by the user');
      })
    );
  } finally {
    restore();
  }

  assert.equal(limited, MAX_ATTEMPTS, 'a rate limit is retried, but not for ever');
  assert.equal(blocked, 1, 'a block is hopeless — retrying it is pure waste');
});
