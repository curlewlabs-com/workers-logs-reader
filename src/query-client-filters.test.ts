import { describe, expect, it } from "bun:test";
import { type LogsFilter, queryLogEventsTuned } from "./query-client";
import {
  configWith,
  pageResponse,
  recordingFetch,
  timeframeOf,
  widthAwareFetch,
} from "./test-fixtures";

const FILTERS: readonly LogsFilter[] = [
  { key: "$metadata.service", value: "worker-a" },
  { key: "$workers.scriptVersion.id", value: "version-1" },
];

const FILTER_PARAMETERS = {
  filterCombination: "and",
  filters: [
    {
      key: "$metadata.service",
      operation: "eq",
      type: "string",
      value: "worker-a",
    },
    {
      key: "$workers.scriptVersion.id",
      operation: "eq",
      type: "string",
      value: "version-1",
    },
  ],
};

function parametersOf(call: { init: RequestInit | undefined }): unknown {
  return JSON.parse(call.init?.body as string).parameters;
}

describe("queryLogEvents filters", () => {
  // A cursor page that dropped the filters would widen mid-traversal: page 0 holds
  // one Worker's events and page 1 every Worker's, and the caller sees only a
  // larger count.
  it("carries the filters on every page of the window", async () => {
    const { fetchImpl, calls } = recordingFetch((_url, index) =>
      index === 0 ? pageResponse(["id-a", "id-b"]) : pageResponse(["id-c"]),
    );

    const { events } = await queryLogEventsTuned(
      configWith(fetchImpl, { filters: FILTERS }),
    );

    expect(events).toHaveLength(3);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(parametersOf(call)).toEqual({
        datasets: ["cloudflare-workers"],
        ...FILTER_PARAMETERS,
      });
    }
  });

  it("sends the filters beside a needle", async () => {
    const { fetchImpl, calls } = recordingFetch(() => pageResponse(["id-a"]));

    await queryLogEventsTuned(
      configWith(fetchImpl, { filters: FILTERS, needle: "request-7f3a" }),
    );

    expect(calls).toHaveLength(1);
    expect(parametersOf(calls[0]!)).toEqual({
      datasets: ["cloudflare-workers"],
      needle: { value: "request-7f3a", isRegex: false, matchCase: true },
      ...FILTER_PARAMETERS,
    });
  });

  // An empty list narrows nothing, so it must not send a filter clause the API
  // could read differently from none.
  it("sends no filter clause for an empty list", async () => {
    const { fetchImpl, calls } = recordingFetch(() => pageResponse([]));

    await queryLogEventsTuned(configWith(fetchImpl, { filters: [] }));

    expect(parametersOf(calls[0]!)).toEqual({
      datasets: ["cloudflare-workers"],
    });
  });

  // The heal re-reads a sampled window by the same request and then in narrower
  // pieces. A heal read that lost the filters would replace one Worker's sampled
  // events with every Worker's events at full resolution, and report the read
  // complete. The filters must also leave the traversal itself alone: the same
  // windows, in the same order, with the same result as the unfiltered read.
  it("carries the filters on every retried and narrowed window, healing as without them", async () => {
    const tuning = {
      fromMs: 0,
      toMs: 5999,
      chunkMs: 3000,
      narrowWidthsMs: [1000],
      samplingRetries: 1,
    };
    const unfiltered = widthAwareFetch(1000);
    const filtered = widthAwareFetch(1000);

    const plain = await queryLogEventsTuned(
      configWith(unfiltered.fetchImpl, tuning),
    );
    const narrowed = await queryLogEventsTuned(
      configWith(filtered.fetchImpl, { ...tuning, filters: FILTERS }),
    );

    expect(narrowed).toEqual(plain);
    expect(narrowed.maxAbrLevel).toBe(1);
    expect(filtered.calls.map(timeframeOf)).toEqual(
      unfiltered.calls.map(timeframeOf),
    );
    // Two chunks, each a sampled read, its sampled retry and three narrower windows.
    expect(filtered.calls).toHaveLength(10);
    for (const call of filtered.calls) {
      expect(parametersOf(call)).toEqual({
        datasets: ["cloudflare-workers"],
        ...FILTER_PARAMETERS,
      });
    }
  });
});
