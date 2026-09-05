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
  MENU_KEYS,
  PUBLIC_COMMANDS,
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
} = require('../src/utils/i18n');
const { mainMenu } = require('../src/keyboards');
const en = require('../src/locales/en');
const ru = require('../src/locales/ru');
const db = require('../src/services/database');
const { FREE_LIMITS, PREMIUM_LIMITS } = require('../src/models/subscription');

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

test('every button actually rendered in the menu is recognised by isMenuButtonText', () => {
  // Guards the real failure mode: adding a button to mainMenu() but forgetting
  // MENU_KEYS, so a tap on it inside a group is stored as conversation and
  // pollutes summaries. Derived from the rendered keyboard, not a hardcoded
  // list, so it fails automatically if the two ever drift.
  for (const lang of SUPPORTED_LANGUAGES) {
    const rows = mainMenu(lang).reply_markup.keyboard;
    const rendered = rows.flat().map((b) => (typeof b === 'string' ? b : b.text));
    assert.ok(rendered.length > 0, 'menu should render buttons');

    for (const label of rendered) {
      assert.ok(
        isMenuButtonText(label),
        `"${label}" (${lang}) is in the menu but not in MENU_KEYS — a tap on it in a group would be stored as a message`
      );
    }
  }
});

test('isMenuButtonText recognises reply-keyboard labels in every language', () => {
  for (const key of MENU_KEYS) {
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

test('every command published to Telegram has a description in every language', () => {
  // setMyCommands rejects the whole list if one description is missing, and it
  // runs at startup where nobody is watching — so the gap has to fail here.
  assert.ok(PUBLIC_COMMANDS.length > 0);
  assert.ok(
    !PUBLIC_COMMANDS.includes('stats'),
    '/stats is admin-only and its existence is meant to stay undiscoverable'
  );

  for (const command of PUBLIC_COMMANDS) {
    for (const lang of SUPPORTED_LANGUAGES) {
      const description = t(lang, `commands.${command}`);
      assert.notEqual(description, `commands.${command}`, `no ${lang} description for /${command}`);
      assert.ok(description.length <= 256, `${lang} description for /${command} is too long for Telegram`);
      assert.ok(!description.includes('\n'), `${lang} description for /${command} must be one line`);
    }
  }
});

test('every command in the guide and the greeting is one the bot actually answers', () => {
  // Copy drifts faster than code: a command named in the instructions but never
  // registered is a dead end the user finds before we do.
  // pause/resume are real commands kept out of PUBLIC_COMMANDS on purpose:
  // they only mean anything inside a group, so publishing them to the "/" menu
  // would put two dead entries in front of every DM user.
  const known = new Set([...PUBLIC_COMMANDS, 'addchannel', 'removechannel', 'setprivacy', 'pause', 'resume']);

  for (const lang of SUPPORTED_LANGUAGES) {
    const copy = [t(lang, 'help.text'), t(lang, 'start.greeting'), t(lang, 'onboarding.joined')].join('\n');
    // Anchored to a word boundary, so "replies/mentions" reads as prose.
    for (const [, command] of copy.matchAll(/(?:^|[\s(])\/([a-z]+)/gm)) {
      assert.ok(known.has(command), `"/${command}" is offered in the ${lang} copy but is not a command`);
    }
  }
});

test('the guide is one sendable Telegram message with balanced Markdown', () => {
  const params = {
    freeSummaries: FREE_LIMITS.maxSummariesPerDay,
    freeHours: FREE_LIMITS.maxLookbackHours,
    premiumHours: PREMIUM_LIMITS.maxLookbackHours,
    freeGroups: FREE_LIMITS.maxGroups,
    freeChannels: FREE_LIMITS.maxChannels,
    premiumChannels: PREMIUM_LIMITS.maxChannels,
    freeKeywords: FREE_LIMITS.maxKeywords,
    premiumKeywords: PREMIUM_LIMITS.maxKeywords,
  };

  for (const lang of SUPPORTED_LANGUAGES) {
    const text = t(lang, 'help.text', params);

    assert.ok(text.length <= 4096, `the ${lang} guide is ${text.length} chars — Telegram caps a message at 4096`);
    assert.ok(!text.includes('{'), `the ${lang} guide still has an unfilled placeholder`);
    assert.ok(!text.includes('Infinity'), `the ${lang} guide prints Infinity instead of saying "unlimited"`);

    // Telegram rejects a message whose legacy-Markdown entities do not close,
    // so an odd count means the guide would never be delivered at all.
    for (const [name, char] of [['bold', '*'], ['code', '`'], ['italic', '_']]) {
      const count = text.split(char).length - 1;
      assert.equal(count % 2, 0, `unbalanced ${name} marker (${char}) in the ${lang} guide`);
    }
  }
});

test('the privacy policy is one sendable message that still names the processor', () => {
  // /privacy is the only disclosure most users will ever read, and it is sent
  // with parse_mode Markdown — so it has the same two hard constraints as the
  // guide, plus one of its own: it must keep naming who actually receives
  // message content. Dropping that name is a silent compliance regression, and
  // it is exactly the kind of thing a copy edit does by accident.
  const { GROUP_MESSAGE_CHARS } = require('../src/services/digest');

  for (const lang of SUPPORTED_LANGUAGES) {
    const text = t(lang, 'privacy.policy', {
      retentionDays: 90,
      purgeDays: 7,
      groupChars: GROUP_MESSAGE_CHARS,
    });

    assert.ok(text.length <= 4096, `the ${lang} privacy policy is ${text.length} chars — Telegram caps a message at 4096`);
    assert.ok(!text.includes('{'), `the ${lang} privacy policy still has an unfilled placeholder`);
    assert.ok(text.includes('DeepSeek'), `the ${lang} privacy policy no longer names DeepSeek as the processor`);
    assert.ok(
      text.includes(String(GROUP_MESSAGE_CHARS)),
      `the ${lang} privacy policy should state how much of each message is sent, from the constant`
    );

    for (const [name, char] of [['bold', '*'], ['code', '`'], ['italic', '_']]) {
      const count = text.split(char).length - 1;
      assert.equal(count % 2, 0, `unbalanced ${name} marker (${char}) in the ${lang} privacy policy`);
    }
  }
});
