// Category filters used to be matched by testing whether the message text
// contained the category's storage key ("Tech", "Business"). That silently
// never fired for Russian groups — Russian text does not contain the word
// "tech" — and even in English it only caught messages that happened to use
// that one word. A category is a topic, not a keyword, so each one carries a
// vocabulary instead.
//
// The vocabularies deliberately span both languages regardless of the user's
// interface language: someone reading the bot in Russian may well sit in an
// English-speaking group. It is the *message* language that decides what
// matches, not the UI language.
//
// A trailing "*" means "this stem plus any ending" — the main way Russian
// inflection is handled (технолог* covers технологии, технологический,
// технологиям). Terms without "*" must match a whole word, which is how short
// or ambiguous terms stay safe: "ai" as a whole word is artificial
// intelligence, but as a prefix it would swallow "aid", "air" and "aim".
//
// These lists are heuristics and are meant to be tuned as real traffic shows
// what people actually discuss.
const CATEGORY_TERMS = {
  Tech: [
    // English
    'tech*', 'software', 'hardware', 'startup*', 'ai', 'llm*', 'chatgpt',
    'machine learning', 'neural*', 'algorithm*', 'programming', 'programmer*',
    'developer*', 'devops', 'api', 'apis', 'cloud', 'cyber*', 'crypto*',
    'blockchain', 'gadget*', 'smartphone*', 'iphone', 'android', 'saas',
    'database*', 'server*', 'open source', 'github', 'gpu*', 'code', 'coding',
    'app', 'apps', 'deploy*',
    // Russian
    'технолог*', 'софт*', 'программ*', 'разработ*', 'нейросет*', 'нейронн*',
    'алгоритм*', 'приложени*', 'гаджет*', 'смартфон*', 'сервер*', 'облачн*',
    'кибер*', 'крипто*', 'блокчейн*', 'стартап*', 'айти', 'интеллект*', 'ии',
    // Borrowed dev jargon, which is what Russian-speaking tech chats actually
    // use. "баг" is spelled out per form on purpose: as a stem it would match
    // багаж and багет.
    'релиз*', 'деплой*', 'задеплой*', 'бэкенд*', 'фронтенд*', 'девопс*',
    'коммит*', 'фич*', 'докер', 'кубернет*', 'линукс', 'бд', 'ci',
    'баг', 'баги', 'бага', 'багов', 'багу', 'багом',
  ],

  Business: [
    // English
    'business*', 'revenue', 'profit*', 'invest*', 'funding', 'venture', 'vc',
    'ipo', 'merger*', 'acquisition*', 'market*', 'sales', 'customer*',
    'client*', 'contract*', 'deal', 'deals', 'budget*', 'finance', 'financial',
    'pricing', 'b2b', 'payroll', 'procurement',
    // Russian
    'бизнес*', 'выручк*', 'прибыл*', 'инвест*', 'финанс*', 'клиент*',
    'контракт*', 'сделк*', 'бюджет*', 'продаж*', 'маркетинг*', 'налог*',
    'рынок', 'рынк*', 'ценообразовани*', 'закупк*', 'счёт*', 'оборот*',
  ],

  Science: [
    // English
    'science', 'scientific', 'scientist*', 'research*', 'study', 'studies',
    'experiment*', 'physics', 'chemistry', 'biology', 'genome*', 'genetic*',
    'clinical', 'vaccine*', 'quantum', 'astronomy', 'nasa', 'peer-reviewed',
    // Russian
    'наук*', 'научн*', 'исследовани*', 'учены*', 'эксперимент*', 'физик*',
    'хими*', 'биолог*', 'геном*', 'генетик*', 'вакцин*', 'квантов*',
    'астроном*', 'клиническ*',
  ],

  World: [
    // English
    'world', 'global', 'international', 'geopolit*', 'diplomat*', 'election*',
    'government*', 'president', 'parliament', 'sanction*', 'treaty', 'war',
    'conflict', 'nato', 'embassy', 'summit', 'refugee*',
    // Russian
    'мировы*', 'мирово*', 'междунар*', 'геополит*', 'дипломат*', 'выборы',
    'выборов', 'выборах', 'правительств*', 'президент*', 'парламент*',
    'санкци*', 'войн*', 'конфликт*', 'границ*', 'нато', 'оон', 'посольств*',
    'саммит*', 'беженц*',
  ],

  Sports: [
    // English
    'sport*', 'football', 'soccer', 'basketball', 'hockey', 'tennis',
    'olympic*', 'championship*', 'tournament*', 'league', 'coach', 'fifa',
    'nba', 'nhl', 'ufc', 'marathon', 'world cup',
    // Russian
    'спорт*', 'футбол*', 'баскетбол*', 'хокке*', 'теннис*', 'олимпи*',
    'чемпионат*', 'турнир*', 'матч*', 'лиг*', 'тренер*', 'марафон*', 'забег*',
  ],
};

// The buttons are generated from this list, so a category can never exist
// without a vocabulary (it would be a filter that matches nothing) and a
// vocabulary can never exist without a button (dead weight nobody can pick).
const FILTER_CATEGORIES = Object.keys(CATEGORY_TERMS);

// Russian keyboards and habits treat ё and е interchangeably — "учёные" and
// "учены е" are the same word to a reader, so they must be to the matcher.
// Applied to both the terms and the text, so either spelling finds the other.
function normalize(text) {
  return text.toLowerCase().replace(/ё/g, 'е');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// JavaScript's \b is defined over [A-Za-z0-9_], so it does not see a boundary
// next to Cyrillic at all — \bмир would never match. These Unicode lookarounds
// are the portable equivalent.
const WORD_START = '(?<![\\p{L}\\p{N}])';
const WORD_END = '(?![\\p{L}\\p{N}])';

function termToPattern(term, { allowSuffix }) {
  // A user keyword is taken literally — including any "*" they typed, which is
  // a character to them and not a wildcard they were ever told about.
  if (allowSuffix) return `(?:${WORD_START}${escapeRegExp(normalize(term))})`;

  const isStem = term.endsWith('*');
  const body = escapeRegExp(normalize(isStem ? term.slice(0, -1) : term));
  return `(?:${WORD_START}${body}${isStem ? '' : WORD_END})`;
}

/**
 * Builds a predicate that reports whether a message matches a user's filters.
 * Returns null when there is nothing to match, so callers can skip the work
 * and distinguish "no filters set" from "filters that matched nothing".
 *
 * User keywords are always treated as stems: someone who follows "релиз"
 * means релиза and релизе too, and typing every ending by hand is not a
 * reasonable thing to ask. The "*" suffix convention applies only to the
 * built-in vocabulary; in a user keyword a "*" is just a character.
 */
function buildFilterMatcher({ keywords = [], categories = [] } = {}) {
  const patterns = [
    ...keywords.map((k) => termToPattern(k, { allowSuffix: true })),
    ...categories.flatMap((c) => (CATEGORY_TERMS[c] || []).map((term) => termToPattern(term, { allowSuffix: false }))),
  ];

  if (patterns.length === 0) return null;

  // One combined regex rather than a loop per term: highlights run over every
  // message in the window on every digest.
  const regex = new RegExp(patterns.join('|'), 'iu');
  return (text) => (typeof text === 'string' ? regex.test(normalize(text)) : false);
}

module.exports = { CATEGORY_TERMS, FILTER_CATEGORIES, buildFilterMatcher, normalize };
