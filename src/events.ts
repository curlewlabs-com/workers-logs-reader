// Events as a reader hands them on: grouped by the Worker that emitted them, and
// written out as newline-delimited JSON.

// The group for events whose `$metadata.service` is missing or unusable. They are
// kept rather than dropped: a malformed event is itself a record, and losing it
// silently would understate what was read.
export const UNKNOWN_SERVICE = "_unknown";

// An account-wide query returns every Worker's events in one stream; this fans
// them back out by `$metadata.service`. Order within a service is preserved.
export function partitionEventsByService(
  events: unknown[],
): Map<string, unknown[]> {
  const byService = new Map<string, unknown[]>();
  for (const event of events) {
    const service = serviceOf(event);
    const existing = byService.get(service);
    if (existing) {
      existing.push(event);
    } else {
      byService.set(service, [event]);
    }
  }
  return byService;
}

function serviceOf(event: unknown): string {
  if (typeof event === "object" && event !== null) {
    const meta = (event as Record<string, unknown>)["$metadata"];
    if (typeof meta === "object" && meta !== null) {
      const service = (meta as Record<string, unknown>)["service"];
      if (typeof service === "string" && service.length > 0) {
        return service;
      }
    }
  }
  return UNKNOWN_SERVICE;
}

// One event object per line. Empty in, empty out: a quiet day is an empty file.
export function eventsToNdjson(events: unknown[]): string {
  if (events.length === 0) {
    return "";
  }
  return events.map((event) => JSON.stringify(event)).join("\n") + "\n";
}
