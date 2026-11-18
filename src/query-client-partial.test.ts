import { describe, expect, it } from "bun:test";
import { PartialLogsQueryError, queryLogEventsTuned } from "./query-client";
import {
  configWith,
  pageResponse,
  recordingFetch,
  recordingSleep,
} from "./test-fixtures";

describe("queryLogEvents partial results", () => {
  // Whether the later failure is retryable or definitive, a completed chunk is
  // still evidence. The query keeps that prefix while rejecting so the read
  // cannot mistake it for a complete day.
  it.each([
    {
      failureClass: "exhausted transient retries",
      status: 503,
      statusText: "Service Unavailable",
      expectedCalls: 4,
      expectedDelays: [100, 200],
    },
    {
      failureClass: "definitive API failure",
      status: 403,
      statusText: "Forbidden",
      expectedCalls: 2,
      expectedDelays: [],
    },
  ])(
    "preserves completed chunks after a later $failureClass",
    async ({ status, statusText, expectedCalls, expectedDelays }) => {
      const { fetchImpl, calls } = recordingFetch((_url, index) =>
        index === 0
          ? pageResponse(["id-earlier"])
          : new Response("failed", { status, statusText }),
      );
      const { sleep, delays } = recordingSleep();

      const failure: unknown = await queryLogEventsTuned(
        configWith(fetchImpl, {
          fromMs: 0,
          toMs: 2000,
          chunkMs: 1000,
          transientRetries: 2,
          transientBackoffMs: 100,
          sleep,
        }),
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(PartialLogsQueryError);
      if (!(failure instanceof PartialLogsQueryError)) {
        throw failure;
      }
      expect(failure.partialResult.events).toMatchObject([
        { $metadata: { id: "id-earlier" } },
      ]);
      expect(failure.failedRange).toEqual({ fromMs: 1000, toMs: 1999 });
      expect(failure.failureReason).toMatch(
        new RegExp(`logs query HTTP ${status}`),
      );
      expect(calls).toHaveLength(expectedCalls);
      expect(delays).toEqual([...expectedDelays]);
    },
  );
});
