/**
 * Per-user clock offsets, for showing digest times in the time somebody
 * actually lives in.
 *
 * FIXED OFFSETS, NOT IANA ZONES, and deliberately so. The scheduler matches on
 * scheduled_digests.hour_utc, a stored integer: with a named zone that value
 * would silently mean a different local time twice a year, and every stored row
 * would need rewriting on each DST transition — or the tick would have to
 * resolve the zone at send time for every due digest. A fixed offset is the
 * simpler thing that is actually correct, at the price of a user in a
 * DST-observing country being an hour out for part of the year and having to
 * change it. If that trade ever stops being acceptable, the note above is the
 * decision to revisit, not the code below.
 *
 * NOTHING HERE TOUCHES THE SCHEDULER. hour_utc remains the stored value and the
 * only thing the hourly tick compares. This module decides what a user is
 * shown, and which hour_utc their tap corresponds to.
 */

const MINUTES_PER_DAY = 24 * 60;

/**
 * The offsets offered in the picker. Half-hour ones are included because
 * excluding them would misreport the time for a large number of people rather
 * than merely inconvenience them, and the enumeration below handles them
 * exactly.
 */
const OFFSET_CHOICES = [
  -480, -420, -360, -300, -240, -180, 0, 60, 120, 180, 210, 240, 300, 330, 360, 420, 480, 540, 600, 720,
];

function isValidOffset(minutes) {
  return Number.isInteger(minutes) && OFFSET_CHOICES.includes(minutes);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/** "UTC", "UTC+05:30", "UTC−08:00". */
function formatOffset(offsetMinutes) {
  if (!offsetMinutes) return 'UTC';
  const sign = offsetMinutes > 0 ? '+' : '−';
  const abs = Math.abs(offsetMinutes);
  return `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function wrap(minutes) {
  return ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/**
 * The local clock time at a given UTC hour.
 *
 * The picker enumerates in this direction — one button per hour_utc, labelled
 * with the local time it lands on — rather than offering local hours and
 * converting back. That is what keeps a half-hour offset honest: at UTC+05:30
 * the achievable local times are 08:30, 09:30 and so on, and offering "09:00"
 * would be promising a delivery time the hourly tick cannot produce.
 */
function localTimeAt(hourUtc, offsetMinutes = 0) {
  const total = wrap(hourUtc * 60 + (offsetMinutes || 0));
  return { hour: Math.floor(total / 60), minute: total % 60 };
}

/** "09:30", in the user's own clock, for a given UTC hour. */
function formatLocalTime(hourUtc, offsetMinutes = 0) {
  const { hour, minute } = localTimeAt(hourUtc, offsetMinutes);
  return `${pad(hour)}:${pad(minute)}`;
}

/**
 * The UTC hour that lands on a given local hour — the inverse, for callers that
 * start from "I want it at 9".
 *
 * Rounds down to a whole hour, because hour_utc is an integer and the tick runs
 * on the hour. At a whole-hour offset this is exact; at UTC+05:30 asking for
 * 09:00 local gives the hour that delivers at 08:30.
 */
function utcHourForLocalHour(localHour, offsetMinutes = 0) {
  return Math.floor(wrap(localHour * 60 - (offsetMinutes || 0)) / 60);
}

/**
 * Every hour of the day, ordered by the user's own clock rather than by UTC, so
 * the list reads 00:00 downwards to somebody scrolling it.
 */
function hoursInLocalOrder(offsetMinutes = 0) {
  return Array.from({ length: 24 }, (_, hourUtc) => ({
    hourUtc,
    label: formatLocalTime(hourUtc, offsetMinutes),
    ...localTimeAt(hourUtc, offsetMinutes),
  })).sort((a, b) => a.hour - b.hour || a.minute - b.minute);
}

module.exports = {
  OFFSET_CHOICES,
  isValidOffset,
  formatOffset,
  formatLocalTime,
  localTimeAt,
  utcHourForLocalHour,
  hoursInLocalOrder,
};
