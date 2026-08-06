const test = require('node:test');
const assert = require('node:assert/strict');

const { splitForTelegram, TELEGRAM_MAX_MESSAGE, truncate, escapeMarkdown } = require('../src/utils/formatters');

test('a message within the limit is not split', () => {
  assert.deepEqual(splitForTelegram('short'), ['short']);
  const exact = 'x'.repeat(TELEGRAM_MAX_MESSAGE);
  assert.deepEqual(splitForTelegram(exact), [exact], 'exactly at the limit still sends as one');
});

test('every part of a split message fits Telegram\'s limit', () => {
  // Telegram rejects an oversized message outright rather than trimming it, so
  // a single over-long part loses the whole summary.
  const body = Array.from({ length: 400 }, (_, i) => `- Bullet number ${i} with some padding text`).join('\n');
  const parts = splitForTelegram(body);

  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(part.length <= TELEGRAM_MAX_MESSAGE, `part of ${part.length} chars exceeds the limit`);
  }
});

test('splitting prefers blank lines, then line ends', () => {
  const paragraph = `${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}`;
  const [first, second] = splitForTelegram(paragraph);

  assert.equal(first, 'a'.repeat(3000), 'the break lands on the blank line');
  assert.equal(second, 'b'.repeat(3000));
});

test('no content is lost or duplicated across the split', () => {
  const body = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
  const rejoined = splitForTelegram(body).join('\n');
  assert.equal(rejoined.replace(/\s+/g, ' '), body.replace(/\s+/g, ' '));
});

test('a single unbreakable line longer than the limit is still cut', () => {
  // No newline to break on: cutting mid-line is the only way to send it at all.
  const parts = splitForTelegram('z'.repeat(10000));
  assert.ok(parts.length >= 3);
  for (const part of parts) assert.ok(part.length <= TELEGRAM_MAX_MESSAGE);
  assert.equal(parts.join(''), 'z'.repeat(10000));
});

test('a realistic long channel digest splits into sendable parts', () => {
  // ~2500 chars of Russian summary plus ten 280-char highlights crosses 4096.
  const summary = Array.from({ length: 25 }, (_, i) => `- Пункт номер ${i} ${'текст '.repeat(15)}`).join('\n');
  const highlights = Array.from({ length: 10 }, (_, i) => `• ${escapeMarkdown(truncate('Пост '.repeat(100), 280))} ${i}`).join('\n');
  const body = `📝 Сводка\n\n${summary}\n\n🔔 Совпадения\n${highlights}`;

  assert.ok(body.length > TELEGRAM_MAX_MESSAGE, 'the fixture must actually be over the limit');
  const parts = splitForTelegram(body);
  for (const part of parts) assert.ok(part.length <= TELEGRAM_MAX_MESSAGE);
  assert.ok(parts.length >= 2);
});
