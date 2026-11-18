import { describe, expect, it } from "bun:test";
import { ABR_LEVEL_UNKNOWN, samplingFailure, worseAbrLevel } from "./abr";

describe("worseAbrLevel", () => {
  // The day-wide aggregate keeps the worse (less-complete) level: more
  // downsampling wins so one sampled chunk fails the whole read.
  it("keeps the higher numeric level (more downsampling)", () => {
    expect(worseAbrLevel(1, 10)).toBe(10);
    expect(worseAbrLevel(10, 1)).toBe(10);
    expect(worseAbrLevel(1, 1)).toBe(1);
  });

  // The unknown sentinel dominates any real level (fail closed): one unreadable page
  // poisons the whole day's verdict, where plain Math.max would let -1 lose to a level.
  it("lets ABR_LEVEL_UNKNOWN dominate any numeric level", () => {
    expect(worseAbrLevel(ABR_LEVEL_UNKNOWN, 10)).toBe(ABR_LEVEL_UNKNOWN);
    expect(worseAbrLevel(10, ABR_LEVEL_UNKNOWN)).toBe(ABR_LEVEL_UNKNOWN);
    expect(worseAbrLevel(1, ABR_LEVEL_UNKNOWN)).toBe(ABR_LEVEL_UNKNOWN);
  });
});

describe("samplingFailure", () => {
  // abr_level 1 is full resolution - the complete-read happy path, no failure. The
  // healBudgetExhausted flag is immaterial at full resolution (it is only ever set alongside a
  // sampled span), so a complete read is null regardless of it.
  it("returns null at full resolution (level 1)", () => {
    expect(samplingFailure(1, false)).toBeNull();
    expect(samplingFailure(1, true)).toBeNull();
  });

  // Any level above 1 means Cloudflare served a downsampled subset, so the read is
  // incomplete: a non-null message carrying the observed level.
  it("fails above level 1 with the abr_level in the message", () => {
    expect(samplingFailure(10, false)).toMatch(/abr_level=10/);
    expect(samplingFailure(10, false)).toMatch(/INCOMPLETE/);
  });

  // Floor-exhausted (healBudgetExhausted=false): the span stayed sampled all the way down to the
  // 1-minute floor, so the message names genuine sustained volume and the graduation path - and
  // must NOT call the cause unresolved (it is resolved: proven too big).
  it("calls floor-exhausted sampling genuine volume, not unresolved", () => {
    const failure = samplingFailure(50, false);
    expect(failure).toMatch(/genuinely outgrown/);
    expect(failure).toMatch(/Logpush/);
    expect(failure).not.toMatch(/UNRESOLVED/);
  });

  // Budget-exhausted (healBudgetExhausted=true): the heal budget was spent before the span could be
  // narrowed to the floor, so the cause is UNRESOLVED - the message must say re-pull first and must
  // NOT assert proven volume / "genuinely outgrown" (the false operational diagnosis this guards).
  it("calls budget-exhausted sampling unresolved and points at a re-pull", () => {
    const failure = samplingFailure(50, true);
    expect(failure).toMatch(/abr_level=50/);
    expect(failure).toMatch(/INCOMPLETE/);
    expect(failure).toMatch(/UNRESOLVED/);
    expect(failure).toMatch(/[Rr]e-pull/);
    expect(failure).not.toMatch(/genuinely outgrown/);
  });

  // The unknown sentinel must be caught BEFORE the `<= 1` full-resolution branch (it is
  // -1, which would otherwise read as complete - the fail-open we guard). It fails with a
  // distinct "no usable abr_level" message, not the downsampling one.
  it("fails closed on ABR_LEVEL_UNKNOWN with an unverifiable-completeness message", () => {
    const failure = samplingFailure(ABR_LEVEL_UNKNOWN, false);
    expect(failure).toMatch(/INCOMPLETE/);
    expect(failure).toMatch(/no usable abr_level/);
    expect(failure).not.toMatch(/abr_level=-1/);
  });
});
