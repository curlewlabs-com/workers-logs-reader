// The UTC day a read covers, as the inclusive millisecond window the telemetry
// query takes, and whether that day is over.

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DayWindow {
  ymd: string; // YYYY-MM-DD (UTC)
  fromMs: number; // inclusive start - ymd 00:00:00.000 UTC
  toMs: number; // inclusive end - ymd 23:59:59.999 UTC
  // True iff the window's end is already past (toMs < nowMs): a finished UTC day
  // whose events are frozen. False for the day still in progress, or a later one.
  sealed: boolean;
}

// Which UTC day to read. `override` (YYYY-MM-DD) always wins and names that day.
// With no override, `defaultDay` picks it relative to nowMs:
//   - "prior" (the default): the day before nowMs's UTC date. Read just after
//     midnight UTC, that is a day already over, so no event can still be
//     stamped inside it and paging walks a frozen set (query-client.ts).
//   - "current": nowMs's own day, still in progress. The window is not sealed,
//     so what comes back is the day so far.
// `nowMs` is passed in rather than read from the clock so the result is a pure
// function of its input.
export function utcDayWindow(
  nowMs: number,
  override?: string,
  defaultDay: "prior" | "current" = "prior",
): DayWindow {
  const ymd = override
    ? normalizeIsoDate(override)
    : utcYmd(defaultDay === "current" ? nowMs : nowMs - DAY_MS);
  const startMs = Date.parse(`${ymd}T00:00:00.000Z`);
  // Inclusive end at 23:59:59.999 so consecutive days tile with no gap and no
  // overlap at midnight: an event at exactly the next midnight belongs to the
  // next day. For the current day this end is still in the future, and the query
  // returns the events that exist so far.
  const toMs = startMs + DAY_MS - 1;
  return {
    ymd,
    fromMs: startMs,
    toMs,
    sealed: toMs < nowMs,
  };
}

function utcYmd(nowMs: number): string {
  const dt = new Date(nowMs);
  const year = dt.getUTCFullYear().toString().padStart(4, "0");
  const month = (dt.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = dt.getUTCDate().toString().padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// Validate a YYYY-MM-DD value in shape and as a real calendar date alike: the
// round-trip through Date rejects 2026-13-45, which the pattern alone passes.
function normalizeIsoDate(value: string): string {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error(`date must be YYYY-MM-DD, got ${JSON.stringify(value)}`);
  }
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || utcYmd(parsed.getTime()) !== trimmed) {
    throw new Error(`date is not a real date: ${trimmed}`);
  }
  return trimmed;
}
