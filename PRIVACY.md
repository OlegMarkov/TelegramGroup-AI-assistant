# Privacy Policy

_Last updated: 2026-08-06_

This policy describes what the Telegram Assistant Bot ("the bot") collects, why, and how to remove it. It describes the behaviour actually implemented in this codebase — the retention periods below are enforced automatically by a scheduled job, not just stated here.

## What is collected

When the bot is a member of a group chat:

- **Text messages** sent in that group — the message text, the sender's Telegram display name/username, the message ID, and the timestamp.
- **Group metadata** — the group's ID, title, and type.
- **Membership** — which users have been seen active in which groups, so they can request summaries of those groups.

For public channels a user adds with `/addchannel`:

- **The channel's public username and title**, and which users follow it through the bot.
- **Nothing else.** Channel posts are fetched from the channel's own public web page at the moment a summary is requested, summarized, and discarded. Post text is never written to the database and therefore never appears in backups. Only the generated summary is cached.

Only **public** channels can be added — ones with a `@name` that anyone can open without joining. The bot has no access to private channels, and reads nothing through any user's Telegram account.

For users who interact with the bot directly:

- **Account basics** — Telegram user ID, username, first name.
- **Settings** — filter keywords and categories, scheduled digest preferences.
- **Usage** — counts of commands run (for enforcing free-tier limits) and a log of product events (e.g. "requested a summary", "hit a limit", "subscribed") used for aggregate analytics.
- **Subscription records** — plan, status, expiry, and the Telegram payment charge ID.

## What is NOT collected

- Non-text content: photos, videos, files, voice messages, stickers, and locations are ignored entirely.
- Private one-to-one conversations between other people. The bot only sees messages in groups it has been added to, plus direct messages sent to the bot itself.
- Payment card or banking details. Payments use Telegram Stars; the bot receives only a confirmation and a charge ID, never payment instrument data.
- Commands themselves (messages starting with `/`) are not stored as chat history.

## Why

Message text is stored solely to produce the product's core features: AI-generated summaries of recent group activity, and keyword search over past messages.

## Third parties

Message text is transmitted to the **DeepSeek API** to generate summaries. This is the only third party that receives message content, and it receives it only at the moment a summary is generated. See DeepSeek's own terms for how they handle API data.

The same applies to posts from public channels a user has added: they are sent to DeepSeek to be summarized at request time. Requests to fetch those posts go to Telegram's own public web preview and carry no information about which user asked.

Generated summaries are cached so repeated requests don't re-send the same content.

No data is sold, and no advertising or third-party tracking is present.

## Who can see what

- A group's summaries and search results are available to users the bot has seen active in that group.
- Aggregate, non-identifying usage statistics are visible to the bot operator.
- The bot operator has technical access to the underlying database, as with any self-hosted service.

## Retention

| Data | Retained for |
|---|---|
| Group messages | **90 days**, then deleted automatically |
| Messages in a group the bot was removed from | **7 days** after removal, then deleted |
| Cached summaries | Until the underlying messages change or are deleted |
| Filters, settings, usage counters | Until you delete them (`/forgetme`) |
| Subscription/payment records | Kept as billing records |
| Analytics events | Kept, but unlinked from your account when you use `/forgetme` |

Retention windows are configurable by the operator via `MESSAGE_RETENTION_DAYS` and `PURGE_AFTER_REMOVAL_DAYS`.

## Your controls

- **`/privacy`** — see this summary inside Telegram.
- **`/forgetme`** — permanently delete your stored messages, group links, filters, scheduled digests, and usage counters, and unlink your analytics events. Requires confirmation. Subscription records are retained so billing history and remaining paid time survive.
- **Remove the bot from a group** — stops collection immediately; that group's stored messages are deleted after the 7-day grace period. (The grace period exists so an accidental removal doesn't destroy history; re-adding the bot within it cancels the deletion.)
- **Group admins** can remove the bot or restrict its permissions at any time.

Note that `/forgetme` deletes data collected so far. If you continue chatting in a group the bot is still in, new messages will be stored again.

## A note to group admins

Adding this bot means the text messages of **everyone** in that group will be stored and sent to a third-party AI service. The bot posts a notice explaining this when it joins. You are responsible for ensuring the group's members are comfortable with that — consider asking before adding it, especially in groups discussing sensitive matters.

## Contact

Data deletion beyond `/forgetme`, or any other request, should be directed to the bot operator.
