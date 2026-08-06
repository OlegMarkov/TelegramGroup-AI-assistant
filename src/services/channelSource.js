const axios = require('axios');
const logger = require('../utils/logger');

// Reading public channels goes through Telegram's own web preview
// (https://t.me/s/<handle>) rather than the Bot API, because a bot cannot see
// a channel it has not been added to and cannot enumerate what a user follows.
// The preview is the only unauthenticated, first-party view of a public
// channel, and posts are fetched at request time and never stored — see
// digest.js. Private channels are deliberately out of reach: reaching them
// would mean holding a user's Telegram session, which is an account-takeover
// credential we are not willing to store.
const PREVIEW_ORIGIN = 'https://t.me';

// Telegram usernames: 5-32 characters, must start with a letter, letters,
// digits and underscores only. Anchored, because this value is interpolated
// into a URL — anything looser turns /addchannel into a request generator
// pointed at whatever the caller likes, including this container's own network.
const HANDLE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;

const REQUEST_TIMEOUT_MS = 15000;
const MAX_RESPONSE_BYTES = 3 * 1024 * 1024;
const MAX_PAGES = 5;
const MAX_POSTS = 200;

class ChannelUnavailableError extends Error {
  constructor(handle) {
    super(`No public preview for @${handle}`);
    this.name = 'ChannelUnavailableError';
    this.handle = handle;
  }
}

/**
 * Accepts what people actually paste — @name, t.me/name, https://t.me/s/name —
 * and returns the bare lowercase handle, or null if it is not a valid public
 * username. Returning null rather than a "cleaned" string is deliberate: no
 * caller should ever build a URL from input this function rejected.
 */
function normalizeHandle(input) {
  if (typeof input !== 'string') return null;

  let handle = input.trim();
  handle = handle.replace(/^(?:https?:\/\/)?(?:www\.)?t(?:elegram)?\.me\//i, '');
  handle = handle.replace(/^s\//i, ''); // the /s/ preview prefix
  handle = handle.replace(/^@/, '');
  handle = handle.split(/[/?#]/)[0]; // drop any path, query or fragment

  return HANDLE_PATTERN.test(handle) ? handle.toLowerCase() : null;
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text) {
  return text.replace(/&(#[0-9]+|#x[0-9a-f]+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const isHex = code[1] === 'x' || code[1] === 'X';
      const point = parseInt(isHex ? code.slice(2) : code.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(point) || point <= 0 || point > 0x10ffff) return match;
      try {
        return String.fromCodePoint(point);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[code.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/**
 * Tags are stripped before entities are decoded, never the other way round:
 * a post containing the literal text "&lt;b&gt;" must stay literal text
 * rather than being decoded into markup and then interpreted.
 */
function htmlToText(html) {
  const withBreaks = html.replace(/<br\s*\/?>/gi, '\n');
  const stripped = withBreaks.replace(/<[^>]*>/g, '');
  return decodeEntities(stripped)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const POST_ANCHOR = /data-post="[^"/]+\/(\d+)"/g;
const TEXT_BLOCK = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/;
const POST_TIME = /<time[^>]+datetime="([^"]+)"/;
const CHANNEL_TITLE = /<div class="tgme_channel_info_header_title"[^>]*>\s*<span[^>]*>([\s\S]*?)<\/span>/;

/**
 * Pulls posts out of one preview page.
 *
 * Each post is parsed from its own slice of the document rather than by
 * scanning the page globally: a page of 20 posts routinely contains fewer than
 * 20 text blocks (media-only posts have none), so a global scan silently
 * pairs one post's id with the next post's text.
 */
function parsePreviewPage(html) {
  const anchors = [...html.matchAll(POST_ANCHOR)];
  const posts = [];

  for (let i = 0; i < anchors.length; i += 1) {
    const start = anchors[i].index;
    const end = i + 1 < anchors.length ? anchors[i + 1].index : html.length;
    const slice = html.slice(start, end);

    const id = Number(anchors[i][1]);
    const textMatch = slice.match(TEXT_BLOCK);
    if (!textMatch) continue; // media-only post, nothing to summarize

    const text = htmlToText(textMatch[1]);
    if (!text) continue;

    const timeMatch = slice.match(POST_TIME);
    const createdAt = timeMatch ? new Date(timeMatch[1]) : null;
    if (!createdAt || Number.isNaN(createdAt.getTime())) continue;

    posts.push({ id, text, createdAt: createdAt.toISOString() });
  }

  return posts;
}

function parseChannelTitle(html) {
  const match = html.match(CHANNEL_TITLE);
  return match ? htmlToText(match[1]) : null;
}

async function fetchPreviewPage(handle, before) {
  const query = Number.isInteger(before) && before > 0 ? `?before=${before}` : '';
  const url = `${PREVIEW_ORIGIN}/s/${handle}${query}`;

  try {
    const response = await axios.get(url, {
      timeout: REQUEST_TIMEOUT_MS,
      responseType: 'text',
      // Telegram answers 302 -> /<handle> for anything without a public
      // preview: a private channel, a user account, or a name that does not
      // exist. Not following it is both the error signal and the guarantee
      // that a redirect can never walk this request onto another host.
      maxRedirects: 0,
      maxContentLength: MAX_RESPONSE_BYTES,
      maxBodyLength: MAX_RESPONSE_BYTES,
      validateStatus: (status) => status === 200,
      headers: { 'Accept-Language': 'en' },
    });
    return response.data;
  } catch (error) {
    const status = error.response && error.response.status;
    if (status === 302 || status === 301 || status === 404) {
      throw new ChannelUnavailableError(handle);
    }
    logger.error('Channel preview fetch failed', { handle, status, error: error.message });
    throw error;
  }
}

/**
 * Collapses the two ways the same post can appear twice.
 *
 * Overlapping pages repeat a post under the same id. Albums are subtler: each
 * item is its own message with its own id but the caption is repeated, so the
 * same text arrives two or three times under consecutive ids — observed live
 * on @durov as posts 440 and 442. Left in, it is paid for twice in the prompt
 * and shown twice in the highlights. The earliest id wins, so a post keeps the
 * time it was actually published.
 */
function dedupePosts(posts) {
  const byId = new Map();
  for (const post of posts) byId.set(post.id, post);

  const seenText = new Set();
  return [...byId.values()]
    .sort((a, b) => a.id - b.id)
    .filter((post) => {
      if (seenText.has(post.text)) return false;
      seenText.add(post.text);
      return true;
    });
}

/**
 * Recent posts from a public channel, newest last, limited to `hours`.
 *
 * Walks backwards page by page only while posts are still inside the window,
 * so a quiet channel costs one request and a busy one stops at MAX_PAGES
 * rather than paging through its whole history.
 */
async function fetchChannelPosts(handle, { hours = 24, limit = MAX_POSTS, maxPages = MAX_PAGES } = {}) {
  const safeHandle = normalizeHandle(handle);
  if (!safeHandle) throw new ChannelUnavailableError(String(handle));

  const cutoff = Date.now() - hours * 3600 * 1000;
  const collected = [];
  let before;
  let title = null;

  for (let page = 0; page < maxPages; page += 1) {
    const html = await fetchPreviewPage(safeHandle, before);
    if (title === null) title = parseChannelTitle(html);

    const posts = parsePreviewPage(html);
    if (posts.length === 0) break;

    collected.push(...posts.filter((p) => Date.parse(p.createdAt) >= cutoff));

    const oldest = posts.reduce((min, p) => (p.id < min.id ? p : min), posts[0]);
    if (Date.parse(oldest.createdAt) < cutoff || collected.length >= limit) break;
    before = oldest.id;
  }

  return { title, posts: dedupePosts(collected).slice(-limit) };
}

/** Confirms a channel exists and is publicly readable, and returns its title. */
async function resolveChannel(handle) {
  const safeHandle = normalizeHandle(handle);
  if (!safeHandle) return null;

  const html = await fetchPreviewPage(safeHandle);
  return { handle: safeHandle, title: parseChannelTitle(html) || safeHandle };
}

module.exports = {
  normalizeHandle,
  fetchChannelPosts,
  resolveChannel,
  ChannelUnavailableError,
  // exported for tests
  dedupePosts,
  parsePreviewPage,
  parseChannelTitle,
  htmlToText,
};
