// Shared stubs for the query tests: a recording fetch, recorded and clocked
// sleeps, and pages of the telemetry/query envelope.

import type { FetchLike, TunedConfig } from "./query-client";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

export function recordingFetch(
  handler: (url: string, index: number) => Response,
): {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    const url = input;
    const index = calls.length;
    calls.push({ url, init: init as RequestInit | undefined });
    return Promise.resolve(handler(url, index));
  };
  return { fetchImpl, calls };
}

export function configWith(
  fetchImpl: FetchLike,
  overrides: Partial<TunedConfig> = {},
): TunedConfig {
  return {
    accountId: "acct-id",
    apiToken: "tok-redacted",
    fromMs: 1000,
    toMs: 2000,
    fetchImpl,
    sleep: () => Promise.resolve(),
    // Small so a couple of stub pages exercise the multi-page path.
    pageLimit: 2,
    // Heal-budget deadline defaults to unbounded (Infinity), so tests that don't exercise it heal
    // exactly as a caller with headroom does; the deadline tests override now + healDeadlineMs.
    now: () => 0,
    healDeadlineMs: Number.POSITIVE_INFINITY,
    ...overrides,
  };
}

// Records the backoff delays the paginator sleeps for, so a test can pin the
// adaptive-sampling retry schedule (5s, then 10s at the defaults) without a real timer.
export function recordingSleep(): {
  sleep: (ms: number) => Promise<void>;
  delays: number[];
} {
  const delays: number[] = [];
  return {
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
    delays,
  };
}

// A controllable monotonic clock paired with a recording sleep, for the heal-budget deadline
// tests. now() reads the current value; sleep() records the delay AND advances the clock by it,
// modeling the wall-clock progression a real read sees as backoff burns time - so a test can place
// healDeadlineMs where the clock crosses it after a known number of backoffs, with no real timer.
export function clockedSleep(startMs = 0): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  delays: number[];
} {
  let t = startMs;
  const delays: number[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => {
      delays.push(ms);
      t += ms;
      return Promise.resolve();
    },
    delays,
  };
}

// A fetch stub that models the engine's cost-driven sampling: any query whose window is WIDER
// than `fullResAtOrBelowMs` comes back adaptively sampled (abr_level=100), and any window at or
// below it serves full resolution (abr_level=1). This is what makes window-narrowing escape
// sampling - a narrower window has less query cost. The handler reads the window width off the
// request body's timeframe, so it tracks the actual sub-windows the narrower queries ask for.
export function widthAwareFetch(fullResAtOrBelowMs: number): {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    const url = input;
    calls.push({ url, init: init as RequestInit | undefined });
    const body = JSON.parse((init?.body as string) ?? "{}") as {
      timeframe?: { from?: number; to?: number };
    };
    const from = body.timeframe?.from ?? 0;
    const to = body.timeframe?.to ?? 0;
    const width = to - from + 1;
    return Promise.resolve(
      pageResponse(["id-a"], width > fullResAtOrBelowMs ? 100 : 1),
    );
  };
  return { fetchImpl, calls };
}

export function timeframeOf(call: RecordedCall): { from: number; to: number } {
  return JSON.parse(call.init?.body as string).timeframe;
}

export function authOf(init: RequestInit | undefined): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  return headers?.["Authorization"];
}

export const QUERY_URL =
  "https://api.cloudflare.com/client/v4/accounts/acct-id/workers/observability/telemetry/query";

function event(id: string): unknown {
  return { $metadata: { id }, message: "log line", timestamp: 1782168834097 };
}

// One page of the telemetry/query envelope: result.events.events[] carries the events
// (each event's $metadata.id is the cursor for the next page) and result.statistics
// .abr_level reports the adaptive-sampling level (1 = full resolution; >1 = downsampled).
export function pageResponse(ids: string[], abrLevel = 1): Response {
  return jsonResponse({
    success: true,
    errors: [],
    result: {
      events: { count: ids.length, events: ids.map(event), fields: [] },
      statistics: { abr_level: abrLevel },
    },
  });
}

// A page whose envelope omits result.statistics entirely - the abnormal shape the real
// API never returns (it always carries a positive abr_level, even on an empty window). The
// client must fail closed on it (maxAbrLevel = ABR_LEVEL_UNKNOWN), not read it as complete.
export function pageResponseNoStats(ids: string[]): Response {
  return jsonResponse({
    success: true,
    errors: [],
    result: {
      events: { count: ids.length, events: ids.map(event), fields: [] },
    },
  });
}
