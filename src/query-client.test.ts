import { describe, expect, it, spyOn } from "bun:test";
import {
  type FetchLike,
  queryLogEvents,
  queryLogEventsTuned,
} from "./query-client";
import { ABR_LEVEL_UNKNOWN, samplingFailure } from "./abr";
import {
  QUERY_URL,
  authOf,
  clockedSleep,
  configWith,
  jsonResponse,
  pageResponse,
  pageResponseNoStats,
  recordingFetch,
  recordingSleep,
  timeframeOf,
  widthAwareFetch,
} from "./test-fixtures";

// Workers Observability telemetry/query client. The query protocol (POST with a
// window + dataset, cursor-paginate on $metadata.id) can only be exercised live
// with a Workers-Observability-Read token, so these injected-fetch tests are the
// executable contract for the paginator: account-wide window-scoping (no needle,
// the coverage guarantee that keeps every Worker's cron + DO + fetch events) and
// its counterpart, that a needle a caller DOES pass rides every page; plus cursor
// passing, exhaustion, the first-hit retry, and the completeness failure paths.
// fetch and sleep are injected; a caller passes globalThis.fetch and a real timer.

describe("queryLogEvents", () => {
  // Happy path: a full first page then a short second page. Pins the endpoint, the
  // bearer, the account-wide request body (view/timeframe/dataset only, NO filter),
  // and that the second page carries the previous page's last $metadata.id as the cursor.
  it("pages with the $metadata.id cursor until a short page exhausts the window", async () => {
    const { fetchImpl, calls } = recordingFetch((_url, index) =>
      index === 0 ? pageResponse(["id-a", "id-b"]) : pageResponse(["id-c"]),
    );

    const { events } = await queryLogEventsTuned(configWith(fetchImpl));

    expect(events).toHaveLength(3);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(QUERY_URL);
    expect(calls[0]!.init?.method).toBe("POST");
    expect(authOf(calls[0]!.init)).toBe("Bearer tok-redacted");

    const body0 = JSON.parse(calls[0]!.init?.body as string);
    expect(body0.view).toBe("events");
    expect(body0.timeframe).toEqual({ from: 1000, to: 2000 });
    expect(body0.parameters).toEqual({ datasets: ["cloudflare-workers"] });
    // Account-wide ONLY - no filter of any kind. A service/invocation-type/path
    // filter would silently drop whole Workers or the cron + Durable Object events
    // that share the one Workers Logs dataset with fetch. A caller can partition by
    // service afterward; the query itself stays unfiltered - the coverage guarantee.
    // An absent needle must emit no narrowing at all, which these assertions pin.
    expect(body0.parameters.filters).toBeUndefined();
    expect(body0.parameters.needle).toBeUndefined();
    expect(body0.offset).toBeUndefined();

    const body1 = JSON.parse(calls[1]!.init?.body as string);
    expect(body1.offset).toBe("id-b");
    expect(body1.offsetDirection).toBe("next");
  });

  // The needle is the only narrowing the client will emit, and it rides every page
  // of the window rather than just the first - a cursor page that dropped it would
  // widen mid-traversal and return a different population than page 0, which is the
  // failure a caller filtering on one identity could not see in its own output.
  it("carries a configured needle on every page of the window", async () => {
    const { fetchImpl, calls } = recordingFetch((_url, index) =>
      index === 0 ? pageResponse(["id-a", "id-b"]) : pageResponse(["id-c"]),
    );

    await queryLogEventsTuned(
      configWith(fetchImpl, { needle: "request-7f3a" }),
    );

    expect(calls.length).toBe(2);
    for (const call of calls) {
      const body = JSON.parse(call.init?.body as string);
      expect(body.parameters).toEqual({
        datasets: ["cloudflare-workers"],
        needle: {
          value: "request-7f3a",
          isRegex: false,
          matchCase: true,
        },
      });
    }
  });

  // A quiet day (the first page is already short, here empty) returns no events
  // after a single call - not an error. Threshold-gated logging keeps the happy
  // path near-silent, so low/zero counts are normal.
  it("returns an empty array for a quiet day without a second call", async () => {
    const { fetchImpl, calls } = recordingFetch(() => pageResponse([]));

    const { events } = await queryLogEventsTuned(configWith(fetchImpl));

    expect(events).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  // The first page is the "first hit in a session": a one-time code-10000 envelope
  // flake must be retried once and then succeed.
  it("retries the first page once on the Cloudflare first-hit flake", async () => {
    let attempts = 0;
    const { fetchImpl, calls } = recordingFetch(() => {
      attempts++;
      return attempts === 1
        ? jsonResponse({
            success: false,
            errors: [{ code: 10000, message: "Authentication error" }],
            result: null,
          })
        : pageResponse(["id-a"]);
    });

    const { events } = await queryLogEventsTuned(configWith(fetchImpl));

    expect(events).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  // A non-flake envelope error (e.g. a scope error) must surface immediately, not
  // be retried as the first-hit flake.
  it("does not retry a non-flake query error", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      jsonResponse({
        success: false,
        errors: [{ code: 9109, message: "Invalid access scope" }],
        result: null,
      }),
    );

    await expect(queryLogEventsTuned(configWith(fetchImpl))).rejects.toThrow(
      /\[9109\]/,
    );
    expect(calls).toHaveLength(1);
  });

  // A full page whose events carry no $metadata.id leaves no cursor to advance.
  // Paging again would re-fetch the same page forever, so the client fails loudly
  // rather than silently truncate the read.
  it("throws on a full page with no cursor rather than truncating", async () => {
    const { fetchImpl } = recordingFetch(() =>
      jsonResponse({
        success: true,
        errors: [],
        result: {
          events: { count: 2, events: [{ message: "a" }, { message: "b" }] },
        },
      }),
    );

    await expect(queryLogEventsTuned(configWith(fetchImpl))).rejects.toThrow(
      /no cursor to continue/,
    );
  });

  // A window that never returns a short page (every page full, with a cursor) must
  // stop at the page cap rather than loop forever and hang the caller.
  it("throws after maxPages when the window never exhausts", async () => {
    const { fetchImpl } = recordingFetch((_url, index) =>
      pageResponse([`id-${index}-a`, `id-${index}-b`]),
    );

    await expect(
      queryLogEventsTuned(configWith(fetchImpl, { maxPages: 3 })),
    ).rejects.toThrow(/did not exhaust a chunk within 3 pages/);
  });

  // A non-multiple window wider than the chunk size is split into adjacent queries and keeps
  // its final partial chunk, so the strict loop bound does not trade the zero-width request
  // for a missing tail. Their events concatenate, and bounding each query is what holds it at
  // full resolution instead of asking for an adaptively downsampled whole-day window.
  it("keeps the final partial chunk of a non-multiple window", async () => {
    const { fetchImpl, calls } = recordingFetch((_url, index) =>
      pageResponse([`id-${index}`]),
    );

    const { events } = await queryLogEventsTuned(
      configWith(fetchImpl, { fromMs: 0, toMs: 2500, chunkMs: 1000 }),
    );

    expect(events).toHaveLength(3);
    expect(calls).toHaveLength(3);
    expect(timeframeOf(calls[0]!)).toEqual({ from: 0, to: 999 });
    expect(timeframeOf(calls[1]!)).toEqual({ from: 1000, to: 1999 });
    expect(timeframeOf(calls[2]!)).toEqual({ from: 2000, to: 2500 });
  });

  // An exact-multiple boundary must not start another chunk at toMs, because the
  // telemetry API rejects that zero-width [toMs, toMs] request; nor may it drop
  // toMs, whose events would be lost while the read reports itself complete. The
  // chunk before reaches toMs instead.
  it("reaches toMs from the chunk before instead of a zero-width chunk", async () => {
    const { fetchImpl, calls } = recordingFetch((_url, index) =>
      pageResponse([`id-${index}`]),
    );

    const { events } = await queryLogEventsTuned(
      configWith(fetchImpl, { fromMs: 0, toMs: 3000, chunkMs: 1000 }),
    );

    expect(events).toHaveLength(3);
    expect(calls).toHaveLength(3);
    expect(calls.map(timeframeOf)).toEqual([
      { from: 0, to: 999 },
      { from: 1000, to: 1999 },
      { from: 2000, to: 3000 },
    ]);
  });

  // The query's adaptive-sampling level surfaces as maxAbrLevel so the caller can fail an
  // incomplete read; the max across every page of every chunk wins. Retry + narrowing are
  // disabled here to isolate the cross-page worseAbrLevel combination from the recovery rungs
  // (which are exercised on their own below).
  it("reports the max abr_level seen across pages as maxAbrLevel", async () => {
    const { fetchImpl } = recordingFetch((_url, index) =>
      index === 0
        ? pageResponse(["id-a", "id-b"], 10)
        : pageResponse(["id-c"], 1),
    );

    const { events, maxAbrLevel } = await queryLogEventsTuned(
      configWith(fetchImpl, { samplingRetries: 0, narrowWidthsMs: [] }),
    );

    expect(events).toHaveLength(3);
    expect(maxAbrLevel).toBe(10);
  });

  // A fully full-resolution run reports maxAbrLevel 1 - the complete-read happy path.
  it("reports maxAbrLevel 1 when every page is full resolution", async () => {
    const { fetchImpl } = recordingFetch(() => pageResponse(["id-a"], 1));

    const { maxAbrLevel } = await queryLogEventsTuned(configWith(fetchImpl));

    expect(maxAbrLevel).toBe(1);
  });

  // Fail closed on the completeness boundary: a page whose envelope omits abr_level (an
  // abnormal shape the real API never returns) makes maxAbrLevel ABR_LEVEL_UNKNOWN, so the
  // caller fails the read rather than reading an unreadable response as full resolution.
  it("reports ABR_LEVEL_UNKNOWN when a page omits abr_level", async () => {
    const { fetchImpl } = recordingFetch(() => pageResponseNoStats(["id-a"]));

    const { events, maxAbrLevel } = await queryLogEventsTuned(
      configWith(fetchImpl),
    );

    expect(events).toHaveLength(1);
    expect(maxAbrLevel).toBe(ABR_LEVEL_UNKNOWN);
  });

  // The unknown sentinel must dominate even when other pages are full resolution: a first
  // full page at abr_level=1 then a short page with no statistics still fails closed. Plain
  // Math.max would let the -1 lose to the 1 and silently pass.
  it("lets an unreadable page dominate a full-resolution one (fail closed)", async () => {
    const { fetchImpl } = recordingFetch((_url, index) =>
      index === 0
        ? pageResponse(["id-a", "id-b"], 1)
        : pageResponseNoStats(["id-c"]),
    );

    const { events, maxAbrLevel } = await queryLogEventsTuned(
      configWith(fetchImpl),
    );

    expect(events).toHaveLength(3);
    expect(maxAbrLevel).toBe(ABR_LEVEL_UNKNOWN);
  });

  // A page that comes back adaptively sampled (abr_level > 1) is retried with backoff; when a
  // retry lands at full resolution the sampled attempt is discarded and the read is
  // complete. This is the transient, load-induced sampling a read recovers from without
  // narrowing the chunk - the sealed window's true volume sits under the full-resolution budget.
  it("retries a sampled page with backoff and accepts the full-resolution retry", async () => {
    const { fetchImpl, calls } = recordingFetch((_url, index) =>
      index === 0 ? pageResponse(["id-a"], 100) : pageResponse(["id-a"], 1),
    );
    const { sleep, delays } = recordingSleep();

    const { events, maxAbrLevel } = await queryLogEventsTuned(
      configWith(fetchImpl, { sleep }),
    );

    expect(maxAbrLevel).toBe(1); // sampling cured by the retry -> complete read
    expect(events).toHaveLength(1); // events come from the full-resolution retry, not the sampled attempt
    expect(calls).toHaveLength(2); // initial sampled attempt + one recovering retry
    expect(delays).toEqual([5000]); // one backoff before the retry
  });

  // Sampling that persists past every retry leaves the read incomplete: maxAbrLevel carries
  // the sampled level (so the caller can fail on it), and the backoff
  // follows the exponential schedule (5s, then 10s at the defaults). narrowWidthsMs:[] isolates
  // the retry rung (window-narrowing, the next rung, is exercised separately below).
  it("gives up after the retry budget when sampling persists, surfacing the sampled level", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      pageResponse(["id-a"], 100),
    );
    const { sleep, delays } = recordingSleep();

    const { maxAbrLevel, healBudgetExhausted } = await queryLogEventsTuned(
      configWith(fetchImpl, { sleep, narrowWidthsMs: [] }),
    );

    expect(maxAbrLevel).toBe(100); // still sampled -> incomplete
    expect(healBudgetExhausted).toBe(false); // retries spent normally (not cut by the budget) -> not "unresolved"
    expect(calls).toHaveLength(3); // initial attempt + the default samplingRetries
    expect(delays).toEqual([5000, 10000]); // exponential backoff
  });

  // ABR_LEVEL_UNKNOWN (a drifted response shape) is NOT retried - a retry cannot heal a shape
  // change, so it fails closed at once with no wasted backoff.
  it("does not retry an unreadable abr_level (shape drift fails closed immediately)", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      pageResponseNoStats(["id-a"]),
    );
    const { sleep, delays } = recordingSleep();

    const { maxAbrLevel } = await queryLogEventsTuned(
      configWith(fetchImpl, { sleep }),
    );

    expect(maxAbrLevel).toBe(ABR_LEVEL_UNKNOWN);
    expect(calls).toHaveLength(1); // no retry
    expect(delays).toEqual([]); // no backoff
  });

  // The retry count and backoff base are injectable so the schedule can be tuned (and tests run
  // without real delays): one retry at a 100 ms base here.
  it("honors samplingRetries and samplingBackoffMs overrides", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      pageResponse(["id-a"], 50),
    );
    const { sleep, delays } = recordingSleep();

    const { maxAbrLevel } = await queryLogEventsTuned(
      configWith(fetchImpl, {
        sleep,
        samplingRetries: 1,
        samplingBackoffMs: 100,
        narrowWidthsMs: [], // isolate the retry rung
      }),
    );

    expect(maxAbrLevel).toBe(50);
    expect(calls).toHaveLength(2); // initial + 1 retry
    expect(delays).toEqual([100]);
  });

  // The sampling retry composes with the one-time first-hit flake retry on page 0: the flake is
  // retried first (no backoff), and if that response is itself sampled the sampling retry then
  // recovers it. Each retry layer fires without interfering.
  it("composes the first-hit flake retry with the sampling retry on page 0", async () => {
    const { fetchImpl, calls } = recordingFetch((_url, index) => {
      if (index === 0) {
        return jsonResponse({
          success: false,
          errors: [{ code: 10000, message: "Authentication error" }],
          result: null,
        });
      }
      return index === 1
        ? pageResponse(["id-a"], 100)
        : pageResponse(["id-a"], 1);
    });
    const { sleep, delays } = recordingSleep();

    const { events, maxAbrLevel } = await queryLogEventsTuned(
      configWith(fetchImpl, { sleep }),
    );

    expect(maxAbrLevel).toBe(1);
    expect(events).toHaveLength(1);
    expect(calls).toHaveLength(3); // flake retry (call 1), then sampling retry (call 2)
    expect(delays).toEqual([5000]); // only the sampling retry sleeps; the flake retry does not
  });

  // When a chunk stays sampled past its same-window retries, the offending window is re-queried
  // tiled at the next narrower width; sub-windows that escape sampling restore full resolution,
  // and the sampled wide-window attempt's events are discarded (replaced by the sub-windows).
  // samplingRetries:0 isolates narrowing from the page-retry rung.
  it("narrows a persistently-sampled chunk into sub-windows that recover full resolution", async () => {
    const { fetchImpl, calls } = widthAwareFetch(2000); // windows wider than 2000ms sample

    const { events, maxAbrLevel } = await queryLogEventsTuned(
      configWith(fetchImpl, {
        fromMs: 0,
        toMs: 5999,
        chunkMs: 6000, // one 6000ms top chunk (sampled), narrowed below
        narrowWidthsMs: [2000, 1000],
        samplingRetries: 0,
      }),
    );

    expect(maxAbrLevel).toBe(1); // sub-windows recovered full resolution -> complete
    expect(events).toHaveLength(3); // the sub-windows' events, NOT the discarded sampled attempt
    expect(calls).toHaveLength(4); // 1 sampled wide query + the sub-window queries
    expect(timeframeOf(calls[0]!)).toEqual({ from: 0, to: 5999 }); // the wide, sampled attempt
    // The sub-windows tile the offending span with no gap or overlap.
    expect(timeframeOf(calls[1]!)).toEqual({ from: 0, to: 1999 });
    expect(timeframeOf(calls[2]!)).toEqual({ from: 2000, to: 3999 });
    expect(timeframeOf(calls[3]!)).toEqual({ from: 4000, to: 5999 });
  });

  // A sampled window whose span is an exact multiple of the narrower width must not
  // recreate the API-invalid point-width tail inside the recursive narrowing rung, and
  // must not drop the window's last millisecond either: the sampled attempt it replaces
  // covered it, and the read would report itself complete without its events.
  it("narrows into windows that keep the endpoint, with no zero-width tail", async () => {
    const { fetchImpl, calls } = widthAwareFetch(1001);

    const { events, maxAbrLevel } = await queryLogEventsTuned(
      configWith(fetchImpl, {
        fromMs: 0,
        toMs: 2000,
        chunkMs: 3000,
        narrowWidthsMs: [1000],
        samplingRetries: 0,
      }),
    );

    expect(maxAbrLevel).toBe(1);
    expect(events).toHaveLength(2);
    expect(calls.map(timeframeOf)).toEqual([
      { from: 0, to: 2000 },
      { from: 0, to: 999 },
      { from: 1000, to: 2000 },
    ]);
  });

  // Sampling that survives all the way down the ladder (every width, including the finest) leaves
  // the read incomplete: maxAbrLevel keeps the sampled level so the caller fails the run, and
  // the finest sub-windows' events are still collected (the best available subset). The heal ran to
  // the floor under an ample (default Infinity) budget, so healBudgetExhausted is FALSE - this is
  // the floor-exhausted case (proven volume), the one the caller must NOT report as unresolved.
  it("surfaces the sampled level when narrowing reaches its floor still sampled", async () => {
    const { fetchImpl } = widthAwareFetch(0); // every window samples, even the finest

    const { events, maxAbrLevel, healBudgetExhausted } =
      await queryLogEventsTuned(
        configWith(fetchImpl, {
          fromMs: 0,
          toMs: 5999,
          chunkMs: 6000,
          narrowWidthsMs: [2000, 1000],
          samplingRetries: 0,
        }),
      );

    expect(maxAbrLevel).toBe(100); // never recovered -> incomplete read
    expect(healBudgetExhausted).toBe(false); // floor-exhausted, NOT budget-cut -> proven volume
    expect(events).toHaveLength(6); // six 1000ms floor sub-windows, one event each
  });

  // An empty ladder disables narrowing entirely: a sampled chunk is accepted as incomplete on the
  // spot (its sampled events kept), the behavior before narrowing existed.
  it("accepts a sampled chunk without narrowing when the ladder is empty", async () => {
    const { fetchImpl, calls } = widthAwareFetch(2000);

    const { events, maxAbrLevel } = await queryLogEventsTuned(
      configWith(fetchImpl, {
        fromMs: 0,
        toMs: 5999,
        chunkMs: 6000,
        narrowWidthsMs: [],
        samplingRetries: 0,
      }),
    );

    expect(maxAbrLevel).toBe(100);
    expect(events).toHaveLength(1); // the sampled chunk's own events, kept (no narrowing)
    expect(calls).toHaveLength(1); // no sub-window queries
  });

  // Heal-budget deadline, retry rung: the unbounded retry/narrowing fan-out could run ~17 min per
  // sampled hour and outlast the caller's time limit, killing it before it can keep what it read.
  // The deadline caps healing - checked before each backoff, so
  // once the budget is gone the same-window retries stop and the sampled page is accepted as
  // incomplete. Here the budget (3s) is crossed by the first 5s backoff, so the second retry that an
  // unbounded run would make (cf. "gives up after the retry budget", whose ladder is [5000,10000]) is cut.
  it("stops same-window retries when the heal budget runs out mid-backoff", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      pageResponse(["id-a"], 100),
    ); // always sampled
    const { now, sleep, delays } = clockedSleep();

    const { maxAbrLevel, healBudgetExhausted } = await queryLogEventsTuned(
      configWith(fetchImpl, {
        sleep,
        now,
        healDeadlineMs: 3000, // crossed once the first 5s backoff advances the clock to 5000
        narrowWidthsMs: [], // isolate the retry rung from narrowing
      }),
    );

    expect(maxAbrLevel).toBe(100); // still sampled -> the deadline did NOT weaken the completeness gate
    expect(healBudgetExhausted).toBe(true); // the retry rung was cut short -> cause UNRESOLVED, not proven volume
    expect(calls).toHaveLength(2); // initial + 1 retry, then the deadline stops the 2nd retry
    expect(delays).toEqual([5000]); // only the first backoff; no second 10s sleep
  });

  // Heal-budget deadline, narrowing rung: the expensive rung is the fan-out into sub-windows. When
  // the budget is already spent, a still-sampled chunk is accepted as-is WITHOUT narrowing - its
  // events are kept and its sampled level propagates. Same config as "narrows a persistently-sampled
  // chunk" (which recovers full resolution through the fan-out); the spent deadline alone suppresses the
  // fan-out, proving the cap is what stops it (not an empty ladder).
  it("skips narrowing when the heal budget is already spent (events kept, no fan-out)", async () => {
    const { fetchImpl, calls } = widthAwareFetch(2000); // the 6000ms chunk samples and WOULD narrow

    const { events, maxAbrLevel, healBudgetExhausted } =
      await queryLogEventsTuned(
        configWith(fetchImpl, {
          fromMs: 0,
          toMs: 5999,
          chunkMs: 6000,
          narrowWidthsMs: [2000, 1000], // a ladder that would recover full resolution if reached
          samplingRetries: 0,
          now: () => 1, // already at/after the deadline
          healDeadlineMs: 0,
        }),
      );

    expect(maxAbrLevel).toBe(100); // sampled, not healed - the deadline stopped narrowing
    expect(healBudgetExhausted).toBe(true); // narrowing cut before the floor -> cause UNRESOLVED
    expect(events).toHaveLength(1); // the sampled wide-window's own events, kept
    expect(calls).toHaveLength(1); // NO sub-window fan-out (the fan-out would call again without the deadline)
    expect(timeframeOf(calls[0]!)).toEqual({ from: 0, to: 5999 });
  });

  // The deadline bounds HEALING, never the base traversal - so a later chunk is never dropped just
  // because an earlier one spent the budget. Sampled chunks with the budget already gone: each
  // still gets its one base-pass query (its events collected), neither fans out, and the sampled
  // level propagates so the run reports the read incomplete. This is the no-event-loss invariant.
  it("still base-traverses every later chunk after the deadline (no hour dropped)", async () => {
    const { fetchImpl, calls } = widthAwareFetch(2000); // each 6000ms chunk samples

    const { events, maxAbrLevel, healBudgetExhausted } =
      await queryLogEventsTuned(
        configWith(fetchImpl, {
          fromMs: 0,
          toMs: 11999,
          chunkMs: 6000, // chunks [0..5999] and [6000..11999]
          narrowWidthsMs: [2000, 1000], // would fan out, but the spent budget forbids it
          samplingRetries: 0,
          now: () => 1,
          healDeadlineMs: 0, // already spent before the first chunk
        }),
      );

    expect(events).toHaveLength(2); // EVERY chunk's base events - the second hour is not dropped
    expect(maxAbrLevel).toBe(100); // still sampled -> incomplete
    expect(healBudgetExhausted).toBe(true); // each chunk cut at narrowing -> cause UNRESOLVED
    expect(calls).toHaveLength(2); // one base query per chunk, zero fan-out
    expect(timeframeOf(calls[0]!)).toEqual({ from: 0, to: 5999 });
    expect(timeframeOf(calls[1]!)).toEqual({ from: 6000, to: 11999 });
  });

  // With ample budget the deadline is inert: healing proceeds exactly as without one. Same recovery
  // as "narrows a persistently-sampled chunk" (full resolution through the fan-out) but with a clock + a far-off
  // deadline injected - a guard that the deadline plumbing never bites a run that has headroom.
  it("heals normally when the budget is ample (deadline inert with headroom)", async () => {
    const { fetchImpl, calls } = widthAwareFetch(2000);
    const { now, sleep } = clockedSleep();

    const { events, maxAbrLevel, healBudgetExhausted } =
      await queryLogEventsTuned(
        configWith(fetchImpl, {
          fromMs: 0,
          toMs: 5999,
          chunkMs: 6000,
          narrowWidthsMs: [2000, 1000],
          samplingRetries: 0,
          sleep,
          now,
          healDeadlineMs: 60 * 60 * 1000, // an hour of budget - never reached
        }),
      );

    expect(maxAbrLevel).toBe(1); // narrowing recovered full resolution, exactly as with no deadline
    expect(healBudgetExhausted).toBe(false); // healed within budget - the deadline never bit
    expect(events).toHaveLength(3);
    expect(calls).toHaveLength(4);
  });

  // An HTTP-level failure (not an envelope error) must surface with the status.
  it("throws on a non-ok HTTP response", async () => {
    const { fetchImpl } = recordingFetch(
      () => new Response("nope", { status: 403, statusText: "Forbidden" }),
    );

    await expect(queryLogEventsTuned(configWith(fetchImpl))).rejects.toThrow(
      /logs query HTTP 403/,
    );
  });

  // A transient 5xx is a control-plane blip, not a query error - the account-wide fan-out issues
  // dozens of page requests, so one hiccup mid-fan-out must not lose the whole day's read when a
  // bare re-issue of the idempotent page-query would have recovered it. Retry with backoff and take
  // the recovered response.
  it("retries a transient 5xx page fetch and accepts the recovered response", async () => {
    const { fetchImpl, calls } = recordingFetch((_, index) =>
      index === 0
        ? new Response("boom", {
            status: 500,
            statusText: "Internal Server Error",
          })
        : pageResponse([]),
    );
    const { sleep, delays } = recordingSleep();

    const { events, maxAbrLevel } = await queryLogEventsTuned(
      configWith(fetchImpl, { sleep, transientBackoffMs: 100 }),
    );

    expect(calls).toHaveLength(2); // one failed fetch + the recovered fetch
    expect(delays).toEqual([100]); // one backoff before the retry
    expect(events).toEqual([]);
    expect(maxAbrLevel).toBe(1);
  });

  // 429 (rate-limited) rides the same transient rung as the 5xx family.
  it("retries a 429 page fetch and accepts the recovered response", async () => {
    const { fetchImpl, calls } = recordingFetch((_, index) =>
      index === 0
        ? new Response("slow down", {
            status: 429,
            statusText: "Too Many Requests",
          })
        : pageResponse([]),
    );
    const { sleep, delays } = recordingSleep();

    const { events } = await queryLogEventsTuned(
      configWith(fetchImpl, { sleep, transientBackoffMs: 100 }),
    );

    expect(calls).toHaveLength(2);
    expect(delays).toEqual([100]);
    expect(events).toEqual([]);
  });

  // A transport-layer rejection (connection reset/refused, DNS blip, TLS/socket timeout) yields no
  // HTTP response at all - no server verdict to honor - so on this idempotent query it is retried
  // just like a transient status.
  it("retries a transport-layer fetch rejection and recovers", async () => {
    const seen: number[] = [];
    const fetchImpl: FetchLike = () => {
      const index = seen.length;
      seen.push(index);
      return index === 0
        ? Promise.reject(new Error("socket hang up"))
        : Promise.resolve(pageResponse([]));
    };
    const { sleep, delays } = recordingSleep();

    const { events } = await queryLogEventsTuned(
      configWith(fetchImpl, { sleep, transientBackoffMs: 100 }),
    );

    expect(seen).toHaveLength(2); // one rejection + the recovered fetch
    expect(delays).toEqual([100]);
    expect(events).toEqual([]);
  });

  // A 2xx whose body cannot be JSON-decoded is a truncated/garbled stream (e.g. a proxy dropping the
  // body mid-flight), not a stable API verdict - so it joins the transient-retry set and recovers on
  // re-issue, the same as a transport-layer rejection. Distinct from a well-formed envelope error
  // (success=false), which is a definitive verdict and still fails fast.
  it("retries a 2xx with an undecodable body and recovers", async () => {
    const { fetchImpl, calls } = recordingFetch((_, index) =>
      index === 0
        ? new Response("<<not json>>", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        : pageResponse([]),
    );
    const { sleep, delays } = recordingSleep();

    const { events } = await queryLogEventsTuned(
      configWith(fetchImpl, { sleep, transientBackoffMs: 100 }),
    );

    expect(calls).toHaveLength(2); // one undecodable body + the recovered fetch
    expect(delays).toEqual([100]); // one backoff before the retry
    expect(events).toEqual([]);
  });

  // A persistent transient failure still fails the run once the budget is spent - the retry only
  // adds a recovery chance, it never masks a real outage. Pins the default schedule
  // (retries at 2s exponential) so a change to the defaults is a conscious edit.
  it("gives up after the transient retry budget, surfacing the status", async () => {
    const { fetchImpl, calls } = recordingFetch(
      () =>
        new Response("down", {
          status: 503,
          statusText: "Service Unavailable",
        }),
    );
    const { sleep, delays } = recordingSleep();

    await expect(
      queryLogEventsTuned(configWith(fetchImpl, { sleep })),
    ).rejects.toThrow(/logs query HTTP 503/);

    expect(calls).toHaveLength(6); // initial attempt + the default transientRetries
    expect(delays).toEqual([2000, 4000, 8000, 16000, 32000]); // exponential backoff
  });

  // A non-transient 4xx is a definitive verdict (bad token, missing scope, wrong URL) that a retry
  // cannot fix - it must fail loud on the first response, never enter the backoff loop.
  it("does not retry a non-transient 4xx (fails loud immediately)", async () => {
    const { fetchImpl, calls } = recordingFetch(
      () => new Response("forbidden", { status: 403, statusText: "Forbidden" }),
    );
    const { sleep, delays } = recordingSleep();

    await expect(
      queryLogEventsTuned(configWith(fetchImpl, { sleep })),
    ).rejects.toThrow(/logs query HTTP 403/);

    expect(calls).toHaveLength(1); // no retry
    expect(delays).toEqual([]); // no backoff
  });

  // The transient retry shares the sampling heal budget: past healDeadlineMs it stops re-issuing and
  // lets the failure surface, so a sustained outage fails inside the caller's time limit instead of
  // sleeping past it. Here the deadline (3000) is crossed after the second backoff advances the
  // clock, cutting the retries short of the full five.
  it("stops transient retries once the heal budget is spent", async () => {
    const { fetchImpl, calls } = recordingFetch(
      () =>
        new Response("down", {
          status: 500,
          statusText: "Internal Server Error",
        }),
    );
    const { now, sleep, delays } = clockedSleep();

    await expect(
      queryLogEventsTuned(
        configWith(fetchImpl, { now, sleep, healDeadlineMs: 3000 }),
      ),
    ).rejects.toThrow(/logs query HTTP 500/);

    expect(delays).toEqual([2000, 4000]); // the backoffs before the third, which the deadline stops
    expect(calls).toHaveLength(3); // the fetch after the second backoff sees now() past the deadline
  });
});

describe("queryLogEvents with onPage", () => {
  // A caller that folds the events (sums their sizes, counts them) holds one page
  // at a time instead of a day; the result's events stay empty.
  it("hands each page to onPage and keeps none of them", async () => {
    const { fetchImpl } = recordingFetch((_url, index) =>
      index === 0 ? pageResponse(["id-a", "id-b"]) : pageResponse(["id-c"]),
    );
    const pages: unknown[][] = [];
    const result = await queryLogEventsTuned(
      configWith(fetchImpl, {
        narrowWidthsMs: [],
        onPage: (page) => pages.push([...page]),
      }),
    );
    expect(pages.map((page) => page.length)).toEqual([2, 1]);
    expect(result.events).toEqual([]);
  });

  // Narrowing re-reads a sampled window and discards what it read first, which a
  // fold has already counted, so the public call makes onPage a single pass: one
  // request per page, no retry, no narrowing - and the sampling is still reported,
  // as unresolved: no healing ran, so nothing showed the volume is too large.
  it("reads each page once and reports its sampling as unresolved", async () => {
    const { fetchImpl, calls } = recordingFetch(() =>
      pageResponse(["id-a"], 7),
    );
    const folded: unknown[] = [];
    const result = await queryLogEvents({
      accountId: "acct-id",
      apiToken: "tok-redacted",
      fromMs: 1000,
      toMs: 2000,
      fetchImpl,
      sleep: () => Promise.reject(new Error("a single pass never waits")),
      now: () => 0,
      healDeadlineMs: Number.POSITIVE_INFINITY,
      onPage: (page) => folded.push(...page),
    });
    expect(calls).toHaveLength(1);
    expect(folded).toHaveLength(1);
    expect(result.maxAbrLevel).toBe(7);
    expect(result.healBudgetExhausted).toBe(true);
    expect(
      samplingFailure(result.maxAbrLevel, result.healBudgetExhausted),
    ).toMatch(/UNRESOLVED/);
  });

  // The guard behind it: the tuned entry point refuses the combination outright.
  it("refuses narrowing with a fold", async () => {
    const { fetchImpl } = recordingFetch(() => pageResponse([]));
    await expect(
      queryLogEventsTuned(configWith(fetchImpl, { onPage: () => undefined })),
    ).rejects.toThrow(/onPage requires narrowWidthsMs/);
  });
});

describe("queryLogEvents dataset", () => {
  // Another dataset, the trace spans for one, is read through the same traversal;
  // only the dataset named in the request changes.
  it("names the requested dataset on every page", async () => {
    const { fetchImpl, calls } = recordingFetch((_url, index) =>
      index === 0 ? pageResponse(["id-a", "id-b"]) : pageResponse([]),
    );
    await queryLogEventsTuned(configWith(fetchImpl, { dataset: "otel" }));
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const body = JSON.parse(call.init?.body as string);
      expect(body.parameters).toEqual({ datasets: ["otel"] });
    }
  });
});

describe("queryLogEvents at scale and in its logs", () => {
  // More events than an engine accepts as arguments: spreading them into push()
  // throws a RangeError and fails a read that succeeded.
  it("collects a chunk larger than an engine's argument limit", async () => {
    const pageLimit = 1000;
    const fullPages = 1000;
    const page = (count: number): Response =>
      jsonResponse({
        success: true,
        result: {
          events: {
            events: Array.from({ length: count }, () => ({
              $metadata: { id: "id-x" },
            })),
          },
          statistics: { abr_level: 1 },
        },
      });
    const { fetchImpl } = recordingFetch((_url, index) =>
      page(index < fullPages ? pageLimit : 0),
    );
    const { events } = await queryLogEventsTuned(
      configWith(fetchImpl, { pageLimit, maxPages: fullPages + 1 }),
    );
    expect(events).toHaveLength(pageLimit * fullPages);
  });

  // A failed response's body can echo the query, a needle included, and a retry
  // warning reaches the caller's log whether or not the caller handles anything.
  it("names a retried failure by its status, never by its body", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { fetchImpl } = recordingFetch((_url, index) =>
        index === 0
          ? new Response("never-log-this-body", { status: 503 })
          : pageResponse([]),
      );
      await queryLogEventsTuned(
        configWith(fetchImpl, { transientBackoffMs: 1 }),
      );
      const logged = warn.mock.calls.flat().join("\n");
      expect(logged).toMatch(/HTTP 503/);
      expect(logged).not.toMatch(/never-log-this-body/);
    } finally {
      warn.mockRestore();
    }
  });
});
