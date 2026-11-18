// How a failed Cloudflare API call is read: the body text of a response that
// already failed, and the shape of the control plane's "first hit" flake.

// Only ever called on the error path, to enrich an already-failing (non-2xx)
// response with its body before throwing. A failed body read must not throw
// itself: that would replace the HTTP status, the primary diagnostic, with a
// less informative read error. It degrades to a sentinel instead.
export async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable response body>";
  }
}

// The first control-plane call in a fresh process often answers HTTP 401,
// envelope code 10000, or a generic "Authentication error", with a token that
// succeeds verbatim on the immediate retry. The shapes are deliberately narrow:
// a real outage or a schema change (a 5xx, code 7000) must surface at once, not
// be masked by a retry.
export function isCloudflareFirstHitFlake(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const msg = err.message;
  if (/\bHTTP 401\b/.test(msg)) {
    return true;
  }
  // `[10000]` as `[code] message` renders it, and `[code: 10000]` as other
  // Cloudflare tooling, wrangler included, prints it: the same flake either way.
  if (/\[(?:code:\s*)?10000\]/.test(msg)) {
    return true;
  }
  if (/Authentication error/i.test(msg)) {
    return true;
  }
  return false;
}
