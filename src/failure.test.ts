import { describe, expect, it } from "bun:test";
import { isCloudflareFirstHitFlake, safeReadText } from "./failure";

describe("isCloudflareFirstHitFlake", () => {
  it("matches the documented first-hit flake shapes", () => {
    // HTTP 401 surfaced by a client's response.ok=false path.
    expect(
      isCloudflareFirstHitFlake(
        new Error("D1 HTTP query failed: HTTP 401 Unauthorized -- nope"),
      ),
    ).toBe(true);
    // envelope.success=false carrying control-plane code 10000.
    expect(
      isCloudflareFirstHitFlake(
        new Error("returned success=false: [10000] Authentication error"),
      ),
    ).toBe(true);
    // The same code rendered as `[code: 10000]`, the form other Cloudflare tooling
    // and `wrangler` emit. The bracket match tolerates either form, so the flake is
    // caught even when the message carries no "Authentication error" text.
    expect(
      isCloudflareFirstHitFlake(
        new Error("control-plane call failed: [code: 10000]"),
      ),
    ).toBe(true);
    // Generic "Authentication error" message, case-insensitive.
    expect(isCloudflareFirstHitFlake(new Error("authentication ERROR"))).toBe(
      true,
    );
  });

  it("does not match real outages or non-Error values", () => {
    // A genuine schema/table failure (code 7000) must surface, not retry.
    expect(isCloudflareFirstHitFlake(new Error("[7000] no such table"))).toBe(
      false,
    );
    // HTTP 403 / 5xx are not the first-hit flake.
    expect(isCloudflareFirstHitFlake(new Error("HTTP 403 Forbidden"))).toBe(
      false,
    );
    expect(isCloudflareFirstHitFlake(new Error("HTTP 500 Server Error"))).toBe(
      false,
    );
    // A non-Error value is never a flake even if its text looks like one --
    // guards the `instanceof Error` gate.
    expect(isCloudflareFirstHitFlake("HTTP 401")).toBe(false);
    expect(isCloudflareFirstHitFlake(null)).toBe(false);
  });
});

describe("safeReadText", () => {
  it("returns the body text when readable", async () => {
    expect(await safeReadText(new Response("hello"))).toBe("hello");
  });

  it("degrades to a sentinel instead of throwing when the body read fails", async () => {
    const response = {
      text: () => Promise.reject(new Error("stream broke")),
    } as unknown as Response;
    expect(await safeReadText(response)).toBe("<unreadable response body>");
  });
});
