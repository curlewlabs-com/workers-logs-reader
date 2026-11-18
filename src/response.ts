// One page of the Workers Observability telemetry/query envelope, read into its
// events, the cursor for the next page, and the page's adaptive-sampling level.

import { ABR_LEVEL_UNKNOWN } from "./abr";

export interface LogsPage {
  events: unknown[];
  // The last event's `$metadata.id`, which the API takes as the `offset` of the
  // next page. `| undefined` (not bare optional) so the parser can assign the
  // possibly-absent cursor directly under exactOptionalPropertyTypes.
  cursor?: string | undefined;
  // `result.statistics.abr_level`, or ABR_LEVEL_UNKNOWN when it was absent or
  // not a positive number (abr.ts).
  abrLevel: number;
}

// The events live at `result.events.events[]` and the sampling level at
// `result.statistics.abr_level`. Throws on `success: false`, so an auth or
// scope error (a token without Workers Observability Read) surfaces instead of
// reading as "no events".
export function interpretQueryResponse(json: unknown): LogsPage {
  if (typeof json !== "object" || json === null) {
    throw new Error(
      `logs query response was not an object: ${JSON.stringify(json)}`,
    );
  }
  const envelope = json as {
    success?: unknown;
    errors?: unknown;
    result?: unknown;
  };
  if (envelope.success !== true) {
    throw new Error(
      `logs query returned success=false: ${formatErrors(envelope.errors)}`,
    );
  }
  const result = (envelope.result ?? {}) as {
    events?: { events?: unknown } | null;
    statistics?: { abr_level?: unknown } | null;
  };
  const events = result.events?.events;
  if (!Array.isArray(events)) {
    throw new Error(
      "logs query response carried no result.events.events array",
    );
  }
  // Fail closed on the completeness field: anything but a finite number >= 1 is
  // an abnormal shape, marked ABR_LEVEL_UNKNOWN rather than read as full
  // resolution.
  const abrRaw = result.statistics?.abr_level;
  const abrLevel =
    typeof abrRaw === "number" && Number.isFinite(abrRaw) && abrRaw >= 1
      ? abrRaw
      : ABR_LEVEL_UNKNOWN;
  return {
    events,
    cursor: extractEventId(events[events.length - 1]),
    abrLevel,
  };
}

// Undefined for an empty page or a malformed event. The paginator treats a full
// page with no cursor as an error (it cannot vouch for completeness) rather than
// silently stopping short.
function extractEventId(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) {
    return undefined;
  }
  const meta = (event as Record<string, unknown>)["$metadata"];
  if (typeof meta !== "object" || meta === null) {
    return undefined;
  }
  const id = (meta as Record<string, unknown>)["id"];
  return typeof id === "string" ? id : undefined;
}

function formatErrors(errors: unknown): string {
  if (Array.isArray(errors)) {
    return errors
      .map((entry) => {
        const obj = entry as { code?: unknown; message?: unknown };
        return `[${String(obj.code)}] ${String(obj.message)}`;
      })
      .join("; ");
  }
  return JSON.stringify(errors);
}
