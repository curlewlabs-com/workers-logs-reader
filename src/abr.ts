// The adaptive-sampling level the telemetry query API reports, and the verdict a
// read takes from it.
//
// The API answers a query from a downsampled copy when the query is expensive
// enough, and says so in `result.statistics.abr_level`: 1 is full resolution,
// above 1 means the events returned are a subset. A whole UTC day queried at once
// was seen at abr_level 10, about one event in ten, while an hour stayed at 1.

// Completeness rides entirely on that one untyped external field. The API returns
// it as a positive integer, even for an empty window. This marks a page whose
// abr_level was absent or not a positive number: a response shape no verdict can
// be read from, which is treated as incomplete, never as full resolution.
export const ABR_LEVEL_UNKNOWN = -1;

// The worse (less complete) of two levels, for the window-wide maximum a caller
// judges by. ABR_LEVEL_UNKNOWN dominates any real level; otherwise the higher
// level wins. Math.max would let the -1 sentinel lose to any real level and mask
// an unreadable page.
export function worseAbrLevel(a: number, b: number): number {
  if (a === ABR_LEVEL_UNKNOWN || b === ABR_LEVEL_UNKNOWN) {
    return ABR_LEVEL_UNKNOWN;
  }
  return Math.max(a, b);
}

// Null when every page came back at full resolution; otherwise one line saying
// why the read is incomplete, for the caller to fail on. `healBudgetExhausted`
// (from queryLogEvents) splits abr_level > 1 in two: sampling the heal budget cut
// short is UNRESOLVED - a transient trip was not ruled out, so re-read first -
// while sampling that survived narrowing to the 1-minute floor is sustained
// volume a query cannot read at full resolution.
export function samplingFailure(
  maxAbrLevel: number,
  healBudgetExhausted: boolean,
): string | null {
  // Sentinel first: ABR_LEVEL_UNKNOWN is -1, which would otherwise slip through the
  // `<= 1` full-resolution branch and read as complete (the exact fail-open we guard).
  if (maxAbrLevel === ABR_LEVEL_UNKNOWN) {
    return (
      `Cloudflare's telemetry/query API returned no usable abr_level on at least one ` +
      `1-hour chunk (expected a positive number; the field was absent or invalid), so ` +
      `completeness cannot be verified and the read is treated as INCOMPLETE - the ` +
      `response shape may have drifted; inspect the raw envelope before trusting counts`
    );
  }
  if (maxAbrLevel <= 1) {
    return null;
  }
  // The heal budget running out before the span reached the 1-minute floor does
  // not prove the volume is too large, only that there was no time left to keep
  // healing, so the message must not claim exhaustion or rule out a transient trip.
  if (healBudgetExhausted) {
    return (
      `Cloudflare adaptive query sampling engaged (abr_level=${maxAbrLevel} > 1) on at least ` +
      `one 1-hour chunk, and the wall-clock heal budget was spent before that span finished ` +
      `narrowing - so the read is INCOMPLETE and the cause is UNRESOLVED, NOT proven sustained ` +
      `volume (a transient, load-induced trip was not ruled out). Re-pull the day to disambiguate; ` +
      `if abr_level > 1 persists across re-pulls it is genuine volume - narrow the chunk window ` +
      `further or graduate to Logpush`
    );
  }
  return (
    `Cloudflare adaptive query sampling engaged (abr_level=${maxAbrLevel} > 1) on at least one ` +
    `1-hour chunk - that span stayed downsampled through the full narrowing ladder (down to the ` +
    `1-minute floor), so the read is INCOMPLETE and the hour's volume has genuinely outgrown ` +
    `what a full-resolution query can answer: narrow the chunk window further or graduate to ` +
    `Logpush`
  );
}
