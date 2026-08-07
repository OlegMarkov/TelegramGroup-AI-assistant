const test = require('node:test');
const assert = require('node:assert/strict');

const {
  splitForTelegram,
  TELEGRAM_MAX_MESSAGE,
  truncate,
  escapeMarkdown,
  normalizeModelMarkdown,
} = require('../src/utils/formatters');

test('CommonMark bold from the model becomes Telegram bold', () => {
  // The reported bug: theme headers arrived unformatted. Models write
  // **bold** (CommonMark); Telegram's legacy parse_mode wants *bold* and
  // renders ** as two empty spans around plain text — no error, no bold.
  assert.equal(normalizeModelMarkdown('**Трансфер Родри**'), '*Трансфер Родри*');
  assert.equal(normalizeModelMarkdown('__Bold__'), '_Bold_');
});

test('every header in a real summary is converted', () => {
  // Taken from the production cache for @barcafamilyyy.
  const real =
    '**Контент и статистика**\n- Янчик в соло обыграл защитников.\n\n' +
    '**Трансфер Родри**\n- «Барселона» решила подписать Родри.\n\n' +
    '**Проблемы обороны**\n- Разбор ошибок.';
  const out = normalizeModelMarkdown(real);

  assert.equal((out.match(/\*\*/g) || []).length, 0, 'no double asterisks survive');
  assert.equal((out.match(/^\*[^*\n]+\*$/gm) || []).length, 3, 'all three headers are single-asterisk bold');
  assert.match(out, /^\*Контент и статистика\*$/m);
});

test('asterisks are left balanced so Telegram does not reject the message', () => {
  const out = normalizeModelMarkdown('**a** text **b** more **c**');
  assert.equal((out.match(/\*/g) || []).length % 2, 0, 'an odd count would break parsing');
  assert.equal(out, '*a* text *b* more *c*');
});

test('text that is already Telegram-flavoured is left alone', () => {
  assert.equal(normalizeModelMarkdown('*already bold*'), '*already bold*');
  assert.equal(normalizeModelMarkdown('2 * 3 * 4'), '2 * 3 * 4', 'arithmetic is not emphasis');
  assert.equal(normalizeModelMarkdown('- plain bullet'), '- plain bullet');
});

test('an unpaired ** is left untouched rather than half-converted', () => {
  // Half-converting would leave a stray delimiter, which is the failure this
  // whole area is trying to avoid. The plain-text resend covers the rest.
  assert.equal(normalizeModelMarkdown('**dangling'), '**dangling');
});


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
