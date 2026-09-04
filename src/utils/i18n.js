const en = require('../locales/en');
const ru = require('../locales/ru');

const LOCALES = { en, ru };
const DEFAULT_LANGUAGE = 'en';
const SUPPORTED_LANGUAGES = Object.keys(LOCALES);

function resolvePath(obj, key) {
  return key.split('.').reduce((acc, part) => (acc == null ? undefined : acc[part]), obj);
}

function interpolate(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  );
}

/**
 * Look up a translated string. Falls back to the default locale when a key is
 * missing from a translation, and to the key itself if it's missing entirely —
 * a visible `some.missing.key` in the UI is easier to spot and fix than a
 * silent empty string.
 */
function t(lang, key, params) {
  const locale = LOCALES[lang] || LOCALES[DEFAULT_LANGUAGE];
  let value = resolvePath(locale, key);
  if (typeof value !== 'string') value = resolvePath(LOCALES[DEFAULT_LANGUAGE], key);
  if (typeof value !== 'string') return key;
  return interpolate(value, params);
}

/**
 * Every translation of a key, for `bot.hears()` on reply-keyboard buttons.
 * The keyboard shows one language, but a user who switches language still has
 * the old keyboard rendered in their client until it's replaced, so handlers
 * must accept all variants.
 */
function allTranslations(key) {
  return [...new Set(SUPPORTED_LANGUAGES.map((lang) => t(lang, key)))];
}

// Every reply-keyboard button, in the order they appear in mainMenu().
// Adding a button WITHOUT listing it here means a tap on it inside a group is
// stored as conversation and ends up in summaries — keep the two in sync.
const MENU_KEYS = [
  'menu.summary',
  'menu.find',
  'menu.filters',
  'menu.channels',
  'menu.digest',
  'menu.subscribe',
  'menu.language',
  'menu.privacy',
  'menu.help',
];

const MENU_BUTTON_TEXTS = new Set(MENU_KEYS.flatMap((key) => allTranslations(key)));

/**
 * True if `text` is one of the reply-keyboard button labels, in any language.
 *
 * Reply-keyboard taps arrive as ordinary text messages — unlike `/commands`
 * there is nothing in the payload marking them as UI interactions — so without
 * this check a button press inside a group gets stored as conversation content
 * and ends up in summaries.
 */
function isMenuButtonText(text) {
  return typeof text === 'string' && MENU_BUTTON_TEXTS.has(text.trim());
}


/**
 * Every command published to the "/" menu Telegram shows in the compose bar,
 * in the order users see it. Each one needs a `commands.<name>` translation.
 *
 * /stats is deliberately absent: it is admin-only, and not advertising it is
 * how non-admins are kept from discovering that it exists.
 */
const PUBLIC_COMMANDS = [
  'start',
  'help',
  'summary',
  'find',
  'filter',
  'channels',
  'digest',
  'subscribe',
  'language',
  'privacy',
  'forgetme',
];

/** Map a Telegram `language_code` (e.g. "ru-RU") onto a supported language. */
function normalizeLanguage(code) {
  if (!code) return DEFAULT_LANGUAGE;
  const base = String(code).toLowerCase().split('-')[0];
  return SUPPORTED_LANGUAGES.includes(base) ? base : DEFAULT_LANGUAGE;
}

module.exports = {
  t,
  allTranslations,
  isMenuButtonText,
  normalizeLanguage,
  MENU_KEYS,
  PUBLIC_COMMANDS,
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
};
