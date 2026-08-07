const { z } = require('zod');

/**
 * PRICING — set 2026-08-07: monthly 300, yearly 3000 (was 150 / 1200).
 *
 * Changed before there were any paying subscribers, which is the only cheap
 * time to do it: raising a price on existing customers is a much worse
 * conversation than starting higher.
 *
 * Assumptions: USD/RUB 81.29 (2026-08-07); Telegram Stars payout ~$0.013/star
 * on desktop/web but ~$0.009/star in the mobile apps, where Apple and Google
 * take 30%; blended at a 70/30 mobile/desktop split => ~RUB 0.83 net per star.
 * The payout rates are estimates and have never been checked against a real
 * Stars statement — do that once one exists, because everything here scales
 * directly off them.
 *
 * What the new prices mean
 * - 300 stars nets ~RUB 249/mo, against a face value of roughly RUB 490 to
 *   the buyer. Never reason from the number the user sees; half of it is
 *   Telegram's cut and the app store's.
 * - The RUB 300-500k/mo goal now needs ~1,200-2,000 paying subscribers,
 *   down from ~2,400-4,000 at 150 stars.
 * - 3000/yr is 16.7% off twelve months, i.e. the usual "two months free".
 *   The old 1200 was 33% off and netted less per month than the monthly plan.
 *
 * Still true from the 2026-07-26 review
 * - AI cost is not the constraint and must not anchor the price: ~RUB 0.10
 *   per summary, ~RUB 0.29 worst case. A heavy user at 150 uncached summaries
 *   a month costs ~RUB 44, so gross margin at 300 stars is ~82%. Public
 *   channels raise usage per user, but not enough to change that conclusion.
 * - The payment rail is worth ~30%: a Russian provider (YooKassa,
 *   CloudPayments, ~3%) via Telegram's provider_token would net ~39% more at
 *   an identical price, but needs IP/OOO registration. Stay on Stars to
 *   launch; revisit when revenue justifies the paperwork.
 * - No competitor benchmarks were ever found. Searches surfaced bot-BUILDER
 *   platforms ($7-19/mo), not consumer bot subscriptions, so these numbers
 *   rest on unit economics and the implied subscriber count rather than on
 *   validated market comparables.
 */
const SUBSCRIPTION_PLANS = {
  monthly: { label: 'Monthly', stars: 300, days: 30 },
  yearly: { label: 'Yearly', stars: 3000, days: 365 },
};

// Free users get one channel rather than none, so the feature is something
// they use and outgrow instead of something they only read about on a paywall.
// The premium ceiling is not cosmetic either: every channel is a live fetch
// plus an AI summary, so an uncapped follower list is an uncapped bill.
//
// Because free is no longer zero, "maxChannels === 0" is not a premium test.
// Access is decided per channel by isChannelWithinLimit, the same way groups
// work, so a lapsed subscriber keeps their first channel instead of all 20.
const FREE_LIMITS = {
  maxSummariesPerDay: 3,
  maxLookbackHours: 24,
  scheduledDigests: false,
  maxGroups: 1,
  maxChannels: 1,
};

const PREMIUM_LIMITS = {
  maxSummariesPerDay: Infinity,
  maxLookbackHours: 72,
  scheduledDigests: true,
  maxGroups: Infinity,
  maxChannels: 20,
};

function getLimits(subscription) {
  return subscription ? PREMIUM_LIMITS : FREE_LIMITS;
}

const subscriptionSchema = z.object({
  userId: z.number().int().positive(),
  plan: z.enum(Object.keys(SUBSCRIPTION_PLANS)),
  starsPaid: z.number().int().nonnegative(),
  telegramChargeId: z.string().optional(),
  expiresAt: z.string().optional(),
});

module.exports = { subscriptionSchema, SUBSCRIPTION_PLANS, FREE_LIMITS, PREMIUM_LIMITS, getLimits };
