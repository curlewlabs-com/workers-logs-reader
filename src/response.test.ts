import { describe, expect, it } from "bun:test";
import { ABR_LEVEL_UNKNOWN } from "./abr";
import { interpretQueryResponse } from "./response";

describe("interpretQueryResponse", () => {
  function event(id: string): unknown {
    return { $metadata: { id }, message: "x" };
  }

  // A normal page yields its events and the last event's id as the cursor.
  it("returns the events and the last event's $metadata.id as the cursor", () => {
    const page = interpretQueryResponse({
      success: true,
      errors: [],
      result: { events: { events: [event("id-a"), event("id-b")] } },
    });
    expect(page.events).toHaveLength(2);
    expect(page.cursor).toBe("id-b");
  });

  // An empty page is valid (a quiet day) and carries no cursor.
  it("returns an empty page with no cursor", () => {
    const page = interpretQueryResponse({
      success: true,
      errors: [],
      result: { events: { events: [] } },
    });
    expect(page.events).toHaveLength(0);
    expect(page.cursor).toBeUndefined();
  });

  // The query's adaptive-sampling level rides along on the page so the paginator can
  // surface it: result.statistics.abr_level when present and a positive number.
  it("extracts result.statistics.abr_level as the page's abrLevel", () => {
    const page = interpretQueryResponse({
      success: true,
      errors: [],
      result: {
        events: { events: [event("id-a")] },
        statistics: { abr_level: 10 },
      },
    });
    expect(page.abrLevel).toBe(10);
  });

  // Fail closed on the completeness field: a real response always carries a positive
  // abr_level (even for an empty window, verified against prod), so an absent statistics
  // block is an abnormal shape -> ABR_LEVEL_UNKNOWN, NOT silently full resolution. Reading
  // it as complete would silently fail open on the one field the whole guarantee rides on.
  it("yields ABR_LEVEL_UNKNOWN when statistics is absent", () => {
    const page = interpretQueryResponse({
      success: true,
      errors: [],
      result: { events: { events: [event("id-a")] } },
    });
    expect(page.abrLevel).toBe(ABR_LEVEL_UNKNOWN);
  });

  // A present-but-unusable abr_level (non-numeric, or a non-positive/non-finite number that
  // the API never legitimately returns) is equally abnormal -> ABR_LEVEL_UNKNOWN.
  it("yields ABR_LEVEL_UNKNOWN for a non-numeric or non-positive abr_level", () => {
    for (const bad of ["10", 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const page = interpretQueryResponse({
        success: true,
        errors: [],
        result: {
          events: { events: [event("id-a")] },
          statistics: { abr_level: bad },
        },
      });
      expect(page.abrLevel).toBe(ABR_LEVEL_UNKNOWN);
    }
  });

  // A full page whose last event lacks $metadata.id yields no cursor - the
  // paginator turns that into a hard error rather than truncating.
  it("yields no cursor when the last event has no $metadata.id", () => {
    const page = interpretQueryResponse({
      success: true,
      errors: [],
      result: { events: { events: [{ message: "a" }] } },
    });
    expect(page.cursor).toBeUndefined();
  });

  // success:false (e.g. a token missing Workers Observability Read) must surface,
  // not be misread as "no events".
  it("throws on success:false with the error code", () => {
    expect(() =>
      interpretQueryResponse({
        success: false,
        errors: [{ code: 9109, message: "Invalid access scope" }],
        result: null,
      }),
    ).toThrow(/\[9109\]/);
  });

  it("throws when result.events.events is absent", () => {
    expect(() =>
      interpretQueryResponse({ success: true, errors: [], result: {} }),
    ).toThrow(/no result\.events\.events array/);
  });

  it("throws when the response is not an object", () => {
    expect(() => interpretQueryResponse(null)).toThrow(/was not an object/);
  });
});
