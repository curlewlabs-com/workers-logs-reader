import { describe, expect, it } from "bun:test";
import { utcDayWindow } from "./day";

describe("utcDayWindow", () => {
  // Default: read the day BEFORE nowMs's UTC date, with an inclusive
  // [00:00:00.000, 23:59:59.999] window so consecutive days tile without overlap.
  it("defaults to the prior UTC day with an inclusive full-day window", () => {
    const w = utcDayWindow(Date.parse("2026-06-22T01:00:00.000Z"));
    expect(w.ymd).toBe("2026-06-21");
    expect(w.fromMs).toBe(Date.parse("2026-06-21T00:00:00.000Z"));
    expect(w.toMs).toBe(Date.parse("2026-06-21T23:59:59.999Z"));
    // The window ends exactly 1 ms before the next day's midnight.
    expect(w.toMs + 1).toBe(Date.parse("2026-06-22T00:00:00.000Z"));
    // The prior day is wholly in the past - sealed.
    expect(w.sealed).toBe(true);
  });

  // Seconds after UTC midnight still resolves to the just-completed day - the
  // window is sealed in the past, the property the paginator relies on.
  it("resolves to yesterday for an instant just after UTC midnight", () => {
    expect(utcDayWindow(Date.parse("2026-06-22T00:00:30.000Z")).ymd).toBe(
      "2026-06-21",
    );
  });

  // Late on the day it still reads the prior day (never the in-progress day),
  // so a scheduler delay within the day cannot shift the target.
  it("still reads the prior day late in the day", () => {
    expect(utcDayWindow(Date.parse("2026-06-22T23:59:30.000Z")).ymd).toBe(
      "2026-06-21",
    );
  });

  // Cross-month boundary into a non-leap February: 2026-03-01 -> 2026-02-28.
  it("crosses a month boundary correctly (non-leap February)", () => {
    expect(utcDayWindow(Date.parse("2026-03-01T01:00:00.000Z")).ymd).toBe(
      "2026-02-28",
    );
  });

  // Cross-year boundary: 2026-01-01 -> 2025-12-31.
  it("crosses a year boundary correctly", () => {
    const w = utcDayWindow(Date.parse("2026-01-01T01:00:00.000Z"));
    expect(w.ymd).toBe("2025-12-31");
    expect(w.fromMs).toBe(Date.parse("2025-12-31T00:00:00.000Z"));
  });

  // An override backfills a specific day and ignores nowMs entirely.
  it("uses the override date and ignores nowMs", () => {
    const w = utcDayWindow(
      Date.parse("2026-06-22T01:00:00.000Z"),
      "2025-12-25",
    );
    expect(w.ymd).toBe("2025-12-25");
    expect(w.fromMs).toBe(Date.parse("2025-12-25T00:00:00.000Z"));
  });

  // A malformed override (passes the regex, impossible calendar date) is rejected,
  // not silently turned into a nonsensical window.
  it("rejects an impossible override date", () => {
    expect(() =>
      utcDayWindow(Date.parse("2026-06-22T01:00:00.000Z"), "2026-13-45"),
    ).toThrow(/not a real date/);
  });

  // defaultDay "current" reads nowMs's own in-progress UTC day (same inclusive
  // full-day window, its end still in the future), and the window is unsealed so a
  // caller cannot mistake the day so far for the whole day.
  it("with defaultDay 'current' reads the in-progress UTC day, unsealed", () => {
    const now = Date.parse("2026-06-22T15:30:00.000Z");
    const w = utcDayWindow(now, undefined, "current");
    expect(w.ymd).toBe("2026-06-22");
    expect(w.fromMs).toBe(Date.parse("2026-06-22T00:00:00.000Z"));
    expect(w.toMs).toBe(Date.parse("2026-06-22T23:59:59.999Z"));
    // The window's inclusive end sits ahead of now - the telemetry query just
    // returns whatever events exist so far in the still-open day.
    expect(w.toMs).toBeGreaterThan(now);
    expect(w.sealed).toBe(false);
  });

  // The sealed flag keys off the window's end vs now, so it is correct for an explicit
  // override too: today (still open) and any future date are unsealed; only a
  // complete past day is sealed.
  it("flags an explicit today/future date unsealed and a past date sealed", () => {
    const now = Date.parse("2026-06-22T15:30:00.000Z");
    expect(utcDayWindow(now, "2026-06-22").sealed).toBe(false); // today, still open
    expect(utcDayWindow(now, "2026-06-23").sealed).toBe(false); // future
    expect(utcDayWindow(now, "2026-06-21").sealed).toBe(true); // sealed past day
  });

  // "prior" is the explicit form of the default and must match the bare call.
  it("with defaultDay 'prior' matches the bare-call default (prior day)", () => {
    const now = Date.parse("2026-06-22T01:00:00.000Z");
    expect(utcDayWindow(now, undefined, "prior").ymd).toBe(
      utcDayWindow(now).ymd,
    );
    expect(utcDayWindow(now, undefined, "prior").ymd).toBe("2026-06-21");
  });

  // An explicit override beats defaultDay "current": naming a past day reads that
  // day whatever the default.
  it("an explicit override beats defaultDay 'current'", () => {
    expect(
      utcDayWindow(
        Date.parse("2026-06-22T15:30:00.000Z"),
        "2026-06-20",
        "current",
      ).ymd,
    ).toBe("2026-06-20");
  });
});
