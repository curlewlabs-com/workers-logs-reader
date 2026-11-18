import { describe, expect, it } from "bun:test";
import {
  eventsToNdjson,
  partitionEventsByService,
  UNKNOWN_SERVICE,
} from "./events";

describe("partitionEventsByService", () => {
  const ev = (service: string, id: string): unknown => ({
    $metadata: { service, id },
  });

  // Account-wide events fan out into one group per $metadata.service.
  it("groups events by $metadata.service", () => {
    const groups = partitionEventsByService([
      ev("shop-api", "a"),
      ev("shop-cron", "b"),
      ev("shop-api", "c"),
    ]);
    expect([...groups.keys()].sort()).toEqual(["shop-api", "shop-cron"]);
    expect(groups.get("shop-api")).toHaveLength(2);
    expect(groups.get("shop-cron")).toHaveLength(1);
  });

  // An event with a missing/blank/non-object service lands in UNKNOWN_SERVICE rather
  // than being dropped - a malformed event is still a forensic record.
  it("routes events with no usable service to UNKNOWN_SERVICE", () => {
    const groups = partitionEventsByService([
      { $metadata: { id: "a" } },
      { $metadata: { service: "", id: "b" } },
      "not an object",
      ev("shop-api", "c"),
    ]);
    expect(groups.get(UNKNOWN_SERVICE)).toHaveLength(3);
    expect(groups.get("shop-api")).toHaveLength(1);
  });

  it("returns an empty map for no events", () => {
    expect(partitionEventsByService([]).size).toBe(0);
  });
});

describe("eventsToNdjson", () => {
  it("serializes one event per line with a trailing newline", () => {
    expect(eventsToNdjson([{ a: 1 }, { b: 2 }])).toBe('{"a":1}\n{"b":2}\n');
  });

  // A quiet day serializes to an empty string, with no spurious blank line.
  it("returns an empty string for no events", () => {
    expect(eventsToNdjson([])).toBe("");
  });
});
