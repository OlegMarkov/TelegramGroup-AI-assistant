const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');

const dbPath = path.join(os.tmpdir(), `bot-test-i18n-${crypto.randomUUID()}.db`);
process.env.BOT_TOKEN = 'test-token';
process.env.DATABASE_PATH = dbPath;
process.env.NODE_ENV = 'test';

const {
  t,
  allTranslations,
  isMenuButtonText,
  normalizeLanguage,
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
} = require('../src/utils/i18n');
const en = require('../src/locales/en');
const ru = require('../src/locales/ru');
const db = require('../src/services/database');

test.after(() => {
  db.db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbPath + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

function flattenKeys(obj, prefix = '') {
  return Object.entries(obj).flatMap(([key, value]) => {
    const full = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'object' && value !== null ? flattenKeys(value, full) : [full];
  });
}

test('the Russian locale defines every key the English locale does', () => {
  const enKeys = flattenKeys(en).sort();
  const ruKeys = flattenKeys(ru).sort();

  const missing = enKeys.filter((k) => !ruKeys.includes(k));
  const extra = ruKeys.filter((k) => !enKeys.includes(k));

  assert.deepEqual(missing, [], 'keys present in en but missing from ru');
  assert.deepEqual(extra, [], 'keys present in ru but missing from en');
});

test('every placeholder in an English string also appears in its Russian counterpart', () => {
  const placeholders = (s) => (s.match(/\{(\w+)\}/g) || []).sort();

  for (const key of flattenKeys(en)) {
    const enStr = t('en', key);
    const ruStr = t('ru', key);
    assert.deepEqual(
      placeholders(ruStr),
      placeholders(enStr),
      `placeholder mismatch for "${key}" — a dropped {param} would render a literal brace to users`
    );
  }
});

test('t() interpolates params and falls back predictably', () => {
  assert.equal(t('en', 'common.chatFallback', { id: 42 }), 'Chat 42');
  assert.equal(t('ru', 'common.chatFallback', { id: 42 }), 'Чат 42');

  // Unknown language falls back to the default locale rather than throwing.
  assert.equal(t('zz', 'common.chatFallback', { id: 7 }), t(DEFAULT_LANGUAGE, 'common.chatFallback', { id: 7 }));

  // A missing key returns the key itself, so gaps are visible, not silent.
  assert.equal(t('en', 'nope.not.here'), 'nope.not.here');

  // A missing param leaves the placeholder rather than printing "undefined".
  assert.equal(t('en', 'common.chatFallback'), 'Chat {id}');
});

test('allTranslations returns every language variant, for reply-keyboard matching', () => {
  const variants = allTranslations('menu.summary');
  assert.equal(variants.length, SUPPORTED_LANGUAGES.length);
  assert.ok(variants.includes(en.menu.summary));
  assert.ok(variants.includes(ru.menu.summary));
});

test('isMenuButtonText recognises reply-keyboard labels in every language', () => {
  // Reply-keyboard taps arrive as plain text messages, so without this the
  // button label gets stored as group conversation and pollutes summaries.
  for (const key of ['menu.summary', 'menu.find', 'menu.filters', 'menu.digest', 'menu.subscribe']) {
    for (const lang of SUPPORTED_LANGUAGES) {
      assert.ok(isMenuButtonText(t(lang, key)), `"${t(lang, key)}" (${lang}, ${key}) should be treated as a button`);
    }
  }

  assert.ok(isMenuButtonText(`  ${t('ru', 'menu.summary')}  `), 'surrounding whitespace should not defeat the check');

  // Real conversation must still be ingested.
  assert.equal(isMenuButtonText('Сводка по проекту готова'), false);
  assert.equal(isMenuButtonText('can you summary this'), false);
  assert.equal(isMenuButtonText(''), false);
  assert.equal(isMenuButtonText(undefined), false);
});

test('normalizeLanguage maps Telegram language codes onto supported languages', () => {
  assert.equal(normalizeLanguage('ru'), 'ru');
  assert.equal(normalizeLanguage('ru-RU'), 'ru');
  assert.equal(normalizeLanguage('en-GB'), 'en');
  assert.equal(normalizeLanguage('fr'), DEFAULT_LANGUAGE, 'unsupported languages fall back');
  assert.equal(normalizeLanguage(undefined), DEFAULT_LANGUAGE);
  assert.equal(normalizeLanguage(null), DEFAULT_LANGUAGE);
});

test('a new user is seeded with their Telegram client language, and can change it', () => {
  db.getOrCreateUser({ id: 700, username: 'ru_user', firstName: 'R', language: 'ru' });
  assert.equal(db.getUserLanguage(700), 'ru');

  db.setUserLanguage(700, 'en');
  assert.equal(db.getUserLanguage(700), 'en');
});

test('getUserLanguage returns null when unset, so callers can fall back', () => {
  db.getOrCreateUser({ id: 701, username: 'no_lang', firstName: 'N' });
  assert.equal(db.getUserLanguage(701), null);
  assert.equal(normalizeLanguage(db.getUserLanguage(701)), DEFAULT_LANGUAGE);
});
