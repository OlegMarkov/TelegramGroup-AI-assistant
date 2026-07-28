const { z } = require('zod');

/**
 * PRICING REVIEW — 2026-07-26 (analysis only, prices below are UNCHANGED)
 *
 * Assumptions used: USD/RUB 77.6; Telegram Stars payout ~$0.013/star on
 * desktop/web but ~$0.009/star in the mobile apps (Apple/Google take 30%);
 * blended at a 70/30 mobile/desktop split => ~RUB 0.79 net per star.
 *
 * Findings
 * 1. Current 150 stars nets ~RUB 119/mo, NOT its ~RUB 170 face value.
 *    To reach the RUB 300-500k/mo goal that needs ~2,530-4,210 paying subs,
 *    i.e. ~85k-140k free users at a 2-5% conversion. Very likely too low.
 *    At 500 stars (~RUB 396/mo) the same goal needs only ~760-1,260 subs.
 * 2. AI cost is NOT the constraint and should not anchor the price:
 *    ~RUB 0.10 per summary for a typical 200-message RU group, ~RUB 0.29
 *    worst case. A heavy user at 150 uncached summaries/mo costs ~RUB 44.
 *    Gross margin ~63% at 150 stars, ~89% at 500 stars.
 * 3. The yearly plan is over-discounted: 1200 vs 12x150 is 33% off, against
 *    a ~17% ("two months free") norm. At 500/mo the equivalent is ~5000/yr.
 * 4. Payment rail is worth ~30%: Stars loses 30% on mobile, while a Russian
 *    provider (YooKassa/CloudPayments, ~3%) via Telegram's provider_token
 *    would net ~39% more on an identical price. Needs IP/OOO registration,
 *    so: stay on Stars to launch, revisit once revenue justifies it.
 *
 * Proposed (NOT applied): monthly 500, yearly 5000.
 *
 * Caveat: no solid competitor benchmarks were found — searches surfaced
 * bot-BUILDER platforms ($7-19/mo), not consumer bot subscriptions. The
 * numbers above rest on unit economics and the implied subscriber count,
 * not on validated market comparables. Check 3-5 rival RU-market bots
 * before committing to a number.
 */
const SUBSCRIPTION_PLANS = {
  monthly: { label: 'Monthly', stars: 150, days: 30 },
  yearly: { label: 'Yearly', stars: 1200, days: 365 },
};

const FREE_LIMITS = {
  maxSummariesPerDay: 3,
  maxLookbackHours: 24,
  scheduledDigests: false,
  maxGroups: 1,
};

const PREMIUM_LIMITS = {
  maxSummariesPerDay: Infinity,
  maxLookbackHours: 72,
  scheduledDigests: true,
  maxGroups: Infinity,
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
