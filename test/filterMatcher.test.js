const test = require('node:test');
const assert = require('node:assert/strict');

const { CATEGORY_TERMS, FILTER_CATEGORIES, buildFilterMatcher } = require('../src/services/filterMatcher');
const en = require('../src/locales/en');
const ru = require('../src/locales/ru');

test('the original bug: a Tech filter fires on Russian tech talk', () => {
  // Categories are stored as English keys, so matching used to test whether the
  // message contained the literal string "Tech". Russian messages never do, so
  // a Russian user's filters silently never fired.
  const matches = buildFilterMatcher({ categories: ['Tech'] });

  assert.ok(matches('Выкатили новый релиз, разработчики довольны'), 'разработчики is Tech vocabulary');
  assert.ok(matches('Обсуждаем нейросети и облачные сервера'));
  assert.ok(!matches('Кто идёт обедать в час дня?'), 'ordinary chatter must not be highlighted');
});

test('English still matches, including terms other than the category name', () => {
  const matches = buildFilterMatcher({ categories: ['Tech'] });

  assert.ok(matches('the new tech stack is great'), 'the category name itself still works');
  assert.ok(matches('we should refactor the API layer'), 'a category is a topic, not one keyword');
  assert.ok(!matches('lunch is at one'));
});

test('whole-word terms do not swallow longer words', () => {
  // "ai" is in the Tech vocabulary without a "*", so it must match artificial
  // intelligence and nothing else. As a prefix it would fire on aid, air, aim.
  const matches = buildFilterMatcher({ categories: ['Tech'] });

  assert.ok(matches('AI is changing everything'));
  assert.ok(!matches('we need to aim higher'));
  assert.ok(!matches('send humanitarian aid'));
  assert.ok(!matches('the air conditioning is broken'));
});

test('stem terms follow Russian inflection', () => {
  const matches = buildFilterMatcher({ categories: ['Tech'] });

  for (const form of ['технологии', 'технологиям', 'технологический', 'технологов']) {
    assert.ok(matches(`Говорим про ${form}`), `${form} should match the технолог* stem`);
  }
});

test('short borrowed jargon is listed per form rather than as a stem', () => {
  // Russian tech chats say баг, and баг* would also match багаж and багет.
  const matches = buildFilterMatcher({ categories: ['Tech'] });

  assert.ok(matches('поймали баг на проде'));
  assert.ok(matches('несколько багов осталось'));
  assert.ok(!matches('мой багаж потерялся в аэропорту'));
  assert.ok(!matches('купил багет в пекарне'));
});

test('a stem still only matches at a word start', () => {
  // Cyrillic makes this easy to get wrong: JavaScript's \b is defined over
  // [A-Za-z0-9_], so it sees no boundary next to Cyrillic at all.
  const matches = buildFilterMatcher({ categories: ['World'] });

  assert.ok(matches('мировые цены выросли'));
  assert.ok(!matches('Владимир зайдёт позже'), 'мир inside a name is not world news');
});

test('ё and е are interchangeable in both directions', () => {
  const science = buildFilterMatcher({ categories: ['Science'] });
  assert.ok(science('учёные опубликовали исследование'), 'term is spelled with е, text with ё');
  assert.ok(science('ученые опубликовали исследование'));

  // And the reverse: a term spelled with ё, text without.
  const sports = buildFilterMatcher({ keywords: ['забег'] });
  assert.ok(sports('вчерашний забег отменили'));
});

test('user keywords match as stems so endings do not have to be typed out', () => {
  const matches = buildFilterMatcher({ keywords: ['релиз'] });

  assert.ok(matches('релиз выйдет завтра'));
  assert.ok(matches('до релиза три дня'), 'inflected form should match');
  assert.ok(!matches('пререлизная сборка'), 'but only at a word start');
});

test('regex metacharacters in a user keyword are literal, not syntax', () => {
  // Keywords are user input; an unescaped one would either throw at RegExp
  // construction or match something wild.
  const matches = buildFilterMatcher({ keywords: ['c++', '(beta)', 'a.b'] });

  assert.ok(matches('rewriting it in c++ now'));
  assert.ok(matches('shipped (beta) today'));
  assert.ok(!matches('axb'), '. must not act as a wildcard');
});

test('an empty filter set returns null so callers can skip the work', () => {
  assert.equal(buildFilterMatcher({}), null);
  assert.equal(buildFilterMatcher({ keywords: [], categories: [] }), null);
  assert.equal(buildFilterMatcher(), null);
});

test('an unknown stored category is ignored rather than throwing', () => {
  // A category removed in a later version can still be sitting in a user's
  // saved filters.
  assert.equal(buildFilterMatcher({ categories: ['Retired'] }), null);
  assert.ok(buildFilterMatcher({ categories: ['Retired', 'Sports'] })('матч перенесли'));
});

test('non-string message text is handled without throwing', () => {
  const matches = buildFilterMatcher({ categories: ['Tech'] });
  assert.equal(matches(null), false);
  assert.equal(matches(undefined), false);
});

test('every category has a vocabulary in both languages', () => {
  // A category whose vocabulary covers only one language reintroduces exactly
  // the bug this module exists to fix.
  const hasCyrillic = (s) => /[Ѐ-ӿ]/.test(s);
  const hasLatin = (s) => /[a-z]/i.test(s);

  for (const category of FILTER_CATEGORIES) {
    const terms = CATEGORY_TERMS[category];
    assert.ok(terms.length > 0, `${category} has no terms`);
    assert.ok(terms.some(hasCyrillic), `${category} has no Russian terms`);
    assert.ok(terms.some(hasLatin), `${category} has no English terms`);
  }
});

test('every category has a button label in both locales', () => {
  for (const category of FILTER_CATEGORIES) {
    assert.ok(en.filter.categories[category], `${category} missing an English label`);
    assert.ok(ru.filter.categories[category], `${category} missing a Russian label`);
  }
  assert.deepEqual(
    Object.keys(en.filter.categories).sort(),
    FILTER_CATEGORIES.slice().sort(),
    'locales and vocabulary must not drift apart'
  );
});
