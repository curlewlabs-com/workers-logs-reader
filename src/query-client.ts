// The read of a window of Workers Observability events from the telemetry/query
// API, paged to exhaustion and defended against the API's adaptive sampling.
// Returns the events as one array, with the worst sampling level any page
// reported. If a later chunk fails, PartialLogsQueryError keeps the chunks that
// completed without letting an incomplete read look successful.
//
// The guarantees below are stated for reading a whole UTC day of every Worker in
// an account, which is what the client is sized for. `needle` and `dataset`
// narrow what the API returns; they change which events a window admits, not how
// the window is paged.
//
// Why paging is safe against the classic paginate-while-writing miss/duplicate bug:
//   1. Keyset, not numeric offset - holds for ANY window, sealed or in-progress.
//      The API's `offset` parameter takes the `$metadata.id` (a ULID) of the last
//      event already seen and returns events after it - a cursor anchored to an
//      immutable id, not a "skip N rows" index. A dataset growing under us cannot
//      shift our position the way LIMIT/OFFSET would.
//   2. Sealed window - holds for a day already over. No event can be stamped
//      inside a UTC day that has ended, and events are immutable once ingested, so
//      the result set is frozen before the first page is fetched.
// A sealed day's only residual risk is ingestion lag at the trailing edge (an event at
// 23:59:59 not yet ingested at query time), which reading an hour or so after midnight
// makes negligible. A read of the day in progress has ground 1 only: the keyset cursor
// still rules out the miss/duplicate bug, but events that arrive after the first page -
// newer than the newest event already seen, since paging walks newest-to-oldest - are
// simply not in that read. Either way the read pages to exhaustion (until a short page)
// so a slow tail still completes.
//
// The window is queried in 1-hour CHUNKS, not one whole-day window, because the
// telemetry/query API adaptively samples by query cost: a 24h window is answered from a
// pre-downsampled copy and reports `abr_level` > 1 (abr_level=10, ~1-in-10 events, was
// seen), while a 1h window stays at abr_level=1 = full resolution. Each chunk paginates
// independently (its own cursor); adjacent positive-width chunks have no gap/overlap and their
// events concatenate. An endpoint exactly on the next chunk boundary does not start a rejected
// zero-width query. The max `abr_level` seen is returned so the caller can fail rather than
// keep a sampled subset as complete - see abr.ts samplingFailure.
//
// A page that nonetheless comes back downsampled (abr_level > 1) is handled by a two-rung
// escalation ladder, cheapest first:
//   1. Same-window retry (fetchPageResolvingSampling): re-issue the SAME idempotent page-query
//      (same window + keyset cursor) a few times with exponential backoff. The trip is usually
//      transient, load-induced sampling on an individual page-query, so a short pause normally
//      recovers full resolution at no loss of breadth.
//   2. Window-narrowing (queryWindowNarrowing): if sampling PERSISTS past those retries, the
//      hour's own query cost genuinely outgrew the budget (not a blip), so the chunk is
//      re-queried tiled at progressively narrower windows (10 min, then 1 min) - each a
//      fraction of the cost, almost always back at abr_level=1. This is the same lever that
//      makes the day query in 1-hour chunks, applied recursively and only to the offending span.
// Each rung runs under a wall-clock HEAL budget (healDeadlineMs, which the caller sets against
// its own time limit). Without it the worst case is unbounded: a day sampled in many hours
// would fan retry + narrowing out to ~17 min PER sampled hour (15s of hour retries + 6x + 60x
// sub-window retries), so a few sampled hours would outlast any job timeout and the caller
// would be killed before it could keep what it had read and report it. So once now() reaches
// healDeadlineMs the heal rungs stop and the read accepts what it has as incomplete. The base
// per-chunk traversal (one paginated pass) is NEVER time-boxed, so the deadline only drops heal
// *attempts*, never events.
// Only sampling the heal leaves unresolved - surviving the 1-minute floor, or still present when
// the heal budget is spent - reaches the caller as abr_level > 1. Those are NOT the same signal,
// so the result carries a `healBudgetExhausted` flag that distinguishes them: floor-survived
// (the span stayed downsampled down to the 1-minute floor) is genuine sustained volume, while
// budget-cut (the deadline stopped the heal before the floor was reached) is UNRESOLVED - a
// transient trip was not ruled out, so the caller should read again first. ABR_LEVEL_UNKNOWN
// takes neither rung: an absent/invalid abr_level means the response shape drifted, which
// neither a retry nor a narrower window can heal, so it fails closed at once (and never trips
// the heal budget).
//
// Beneath EVERY rung sits a transport-level retry the sampling ladder never sees: a page fetch that
// fails outright - HTTP 429 or any 5xx (a transient control-plane blip) or a transport error
// (the fetch rejected, or the body was unreadable/undecodable) - is re-issued a few times with
// exponential backoff before it is allowed to fail the read (fetchPage / isTransientQueryError).
// The query is idempotent under the keyset cursor, so a re-issue cannot miss/dup. A non-transient
// HTTP status (any 4xx but 429) or an envelope success=false / shape error is NOT retried here -
// those are definitive server verdicts that must surface at once. These retries are bounded by
// healDeadlineMs too, so a sustained control-plane outage still fails inside the caller's time
// limit instead of sleeping past it.
//
// `fetchImpl`, `sleep`, and a `now` clock are injected so the polling loop AND the
// heal-budget deadline are unit-testable without the network, real delays, or a real clock.
// A caller passes `globalThis.fetch`, a real timer, and `performance.now`; tests pin response
// shapes, a recording sleep, and a fake clock.

import { worseAbrLevel } from "./abr";
import { isCloudflareFirstHitFlake, safeReadText } from "./failure";
import { interpretQueryResponse } from "./response";

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface LogsQueryConfig {
  accountId: string;
  // Needs Workers Observability Read on the account.
  apiToken: string;
  // The window, in epoch ms, both ends inclusive; fromMs must be before toMs. When
  // toMs falls one millisecond past a chunk boundary, the chunk before reaches it
  // (windowEnd), since Cloudflare rejects a point-width [toMs, toMs] query.
  fromMs: number;
  toMs: number;
  // Injected. Never defaulted here so a forgotten injection in a test fails loudly
  // instead of hitting the live API. Typed as the one call the client makes, so
  // a Worker's fetch, Bun's or Node's each fits without a cast.
  fetchImpl: FetchLike;
  sleep: (ms: number) => Promise<void>;
  // Injected monotonic clock + wall-clock deadline that BOUND the adaptive-sampling heal work
  // (same-window retry backoff + narrowing fan-out - see pastHealDeadline and the file header).
  // Once now() >= healDeadlineMs the heal rungs stop and the sampled data is accepted as
  // incomplete; the base per-chunk traversal (one paginated pass) is never cut off, so bounding
  // the heal drops heal attempts, never events. Required, like fetchImpl and sleep, so a
  // forgotten deadline is a compile error rather than a silent unbounded run. Set it under
  // whatever time limit the caller runs within; tests pass an Infinity deadline for unbounded
  // healing.
  now: () => number;
  healDeadlineMs: number;
  // Free-text substring the API matches over the whole event, narrowing the result
  // set server-side - one request's or one identity's events out of a short window,
  // say. Undefined reads every event. Filtering does not disturb the keyset/pagination
  // reasoning in the file header, which is about WHERE the cursor points, not about
  // which events the window admits.
  needle?: string;
  // The dataset to page: the Workers log dataset by default, or another the API
  // holds, such as the trace spans. Nothing else about the query changes with it.
  dataset?: string;
  // When set, each page's events go to this callback and are not kept, so the
  // result's `events` comes back empty: a caller that only folds the events holds
  // one page at a time, not a day. The read is then a single pass - no sampled page
  // is retried and no window is narrowed - because narrowing discards a sampled
  // window's events and re-reads them, which a fold cannot take back, and so that
  // a measurement costs one read of the window. maxAbrLevel still says whether any
  // page was sampled.
  onPage?: (events: readonly unknown[]) => void;
}

// The read's internal settings, each with the default below. Tests set them to
// drive the multi-chunk, multi-page and retry paths with small values; they are
// not part of the package's interface.
export interface QueryTuning {
  // The window is queried in chunks of this many ms (default 1 hour) to stay under
  // Cloudflare's query-time adaptive sampling - see queryLogEvents.
  chunkMs?: number;
  pageLimit?: number;
  // Bounded by page COUNT, not wall time, so the runaway path is deterministic in
  // tests (a stub that always returns a full page hits the cap) and needs no
  // injected clock. 1000 pages x 1000 events = 1M events - far above an hour's
  // volume at full resolution, so a healthy read never approaches it.
  maxPages?: number;
  interPageDelayMs?: number;
  // Adaptive-sampling retry (see DEFAULT_SAMPLING_RETRIES / DEFAULT_SAMPLING_BACKOFF_MS
  // and fetchPageResolvingSampling). When a page returns abr_level > 1, the same page-query is
  // re-issued up to samplingRetries times with exponential backoff (samplingBackoffMs,
  // samplingBackoffMs*2, ...) before the downsampled page is accepted. Only abr_level > 1 is
  // retried - ABR_LEVEL_UNKNOWN (shape drift) fails closed at once.
  samplingRetries?: number;
  samplingBackoffMs?: number;
  // Transient-failure retry (see DEFAULT_TRANSIENT_RETRIES / DEFAULT_TRANSIENT_BACKOFF_MS and
  // fetchPage). A page fetch that fails with a transient control-plane blip - HTTP 429 or any 5xx
  // or a transport error (the fetch rejected, or the body was unreadable) - is re-issued up to
  // transientRetries times with exponential backoff (transientBackoffMs, x2, ...). Idempotent under
  // the keyset cursor, so a re-issue cannot miss/dup. A non-transient 4xx or an envelope/shape error
  // is never retried here - it fails loud.
  transientRetries?: number;
  transientBackoffMs?: number;
  // Window-narrowing ladder (see DEFAULT_NARROW_WIDTHS_MS and queryWindowNarrowing). After a
  // chunk is still downsampled past its same-window retries, it is re-queried tiled at each of
  // these widths in turn (default [10min, 1min]) until full resolution or the list is spent.
  // Empty disables narrowing (a sampled chunk is accepted as incomplete immediately).
  narrowWidthsMs?: number[];
}

export type TunedConfig = LogsQueryConfig & QueryTuning;

const DATASET = "cloudflare-workers";
const DEFAULT_PAGE_LIMIT = 1000;
const DEFAULT_MAX_PAGES = 1000;
const HOUR_MS = 60 * 60 * 1000;
// Query the day in 1-hour windows. Cloudflare's telemetry/query API adaptively samples
// by query cost: a whole-day window is answered from a pre-downsampled copy (`abr_level`
// > 1 - abr_level=10, ~1-in-10 events, was seen), while a 1h (or 6h) window stays at
// abr_level=1 = full resolution. Chunking to an hour is what keeps a read complete; see
// abr.ts samplingFailure.
const DEFAULT_CHUNK_MS = HOUR_MS;

// Adaptive-sampling retry. When a page comes back downsampled (abr_level > 1), the engine
// answered that individual page-query from a pre-downsampled copy - in practice a transient,
// load-induced decision, not a property of the sealed window's (frozen) volume. Re-issuing the
// same idempotent page-query after a short backoff usually lands it at full resolution. Kept
// deliberately small - "a little bit of retry": a couple of attempts with a multi-second,
// exponential backoff (DEFAULT_SAMPLING_BACKOFF_MS, then x2, ... - so 5s then 10s at the
// defaults), not an aggressive hammer. Sampling that persists past the retries goes to the
// narrowing rung below.
const DEFAULT_SAMPLING_RETRIES = 2;
const DEFAULT_SAMPLING_BACKOFF_MS = 5000;

// Window-narrowing ladder - the second rung of the sampling defense, below the same-window
// retry above. If a 1-hour chunk is STILL downsampled after its retries, the sampling is not a
// transient blip but the hour's own query cost genuinely outgrowing the full-resolution budget -
// exactly the case the issue's "narrow the chunk window" remedy targets. Rather than give up,
// re-query that hour tiled at the next width down (10 min, then 1 min): a narrower window has a
// fraction of the cost and almost always drops back to abr_level=1. This is the same lever that
// makes the day query in 1-hour chunks in the first place, applied recursively and ONLY to the
// offending span. Dormant at normal volume (the same-window retry already cured the transient
// case), so a healthy run never subdivides. The 1-min floor is the finest we go; sampling that
// survives even that reaches the caller as an incomplete read (a real graduation-to-Logpush
// signal).
const DEFAULT_NARROW_WIDTHS_MS = [10 * 60 * 1000, 60 * 1000];

// Transient-failure retry - the lowest rung, below the sampling ladder above. A single page fetch
// that fails outright (rather than returning a downsampled page) is re-issued a few times with
// exponential backoff on the theory that the control plane hiccupped, not that the query is wrong.
// Deliberately more generous than the sampling retry (more attempts): losing a whole day's read
// to one blip costs more than a minute of backoff, and the query is a read-only idempotent keyset
// pull, so re-issuing is free of correctness risk. Still doubly bounded - this attempt count AND the
// shared healDeadlineMs - so a sustained outage fails the read inside the caller's time limit,
// never hangs. 2s, 4s, 8s, 16s, 32s at the defaults (~62s of backoff across the default retry count).
const DEFAULT_TRANSIENT_RETRIES = 5;
const DEFAULT_TRANSIENT_BACKOFF_MS = 2000;

// HTTP statuses that are transient control-plane blips on this idempotent query, worth re-issuing:
// 429 (rate-limited) and every 5xx, Cloudflare's own 52x edge errors included. Every OTHER
// non-2xx - 400/401/403/404 etc. - is a definitive verdict (bad token, missing scope, wrong URL)
// that a retry cannot fix and must surface at once. 401 in particular is left to the
// first-hit-flake retry (isCloudflareFirstHitFlake), which owns the run's opening auth wobble.
function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

// A non-OK HTTP response, carrying the numeric status so the transient-retry layer can classify it
// without re-parsing the thrown message. The message keeps the same `logs query HTTP <status>` shape
// the first-hit-flake matcher and the tests read.
class LogsQueryHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LogsQueryHttpError";
  }
}

// A transport-layer failure: the fetch itself rejected (connection reset/refused, DNS blip, TLS or
// socket timeout) or a 2xx body could not be read/decoded (a truncated/garbled stream). No
// well-formed HTTP response came back, so - unlike a 4xx status - there is no server verdict to
// honor; on an idempotent keyset query every such failure is a retry candidate.
class LogsQueryTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LogsQueryTransportError";
  }
}

// True once the run has spent its wall-clock budget for HEALING adaptive sampling (retry
// backoff + narrowing fan-out). Past it the heal rungs stop and the sampled data is accepted
// as incomplete, so the caller still gets the read back inside its own time limit instead of
// being killed mid-fan-out. Only bounds heal attempts - the
// base per-chunk traversal is never gated on it, so no events are dropped. now/healDeadlineMs
// are required (see LogsQueryConfig), so there is no half-configured or time-blind state; tests
// pass an Infinity deadline for unbounded healing.
function pastHealDeadline(config: TunedConfig): boolean {
  return config.now() >= config.healDeadlineMs;
}

export interface LogsQueryResult {
  // Every event across all chunks, in the API's returned order (newest-first within a
  // page, pages walking backward in time; chunks walk forward in time).
  events: unknown[];
  // The worst (least-complete) adaptive-sampling level seen across every page of every
  // chunk (combined via worseAbrLevel). 1 = every chunk served at full resolution (the
  // read is complete); >1 = at least one chunk was downsampled; ABR_LEVEL_UNKNOWN = at
  // least one chunk reported no usable abr_level (fail closed). Anything other than 1 is
  // an incomplete read (abr.ts samplingFailure).
  maxAbrLevel: number;
  // True when the wall-clock heal budget (healDeadlineMs) cut a heal short: at least one
  // sampled span was accepted WITHOUT being narrowed all the way to the 1-minute floor - the
  // same-window retry loop or the narrowing fan-out stopped because now() reached the deadline.
  // It separates the ways an abr_level > 1 reaches the caller, which carry different
  // operator actions: budget-exhausted (UNRESOLVED - not proven sustained volume, a transient
  // trip was not ruled out, so re-pull to disambiguate) vs. floor-exhausted (this flag false -
  // every sampled span stayed downsampled down to the 1-minute floor, a genuine sustained-volume
  // / graduate-to-Logpush signal). samplingFailure words its verdict by it.
  // Meaningful only when maxAbrLevel > 1: false whenever the read is complete (== 1) or fails
  // closed on ABR_LEVEL_UNKNOWN (that path takes neither heal rung, so it never trips the budget).
  healBudgetExhausted: boolean;
}

export class PartialLogsQueryError extends Error {
  constructor(
    readonly partialResult: LogsQueryResult,
    readonly failedRange: { fromMs: number; toMs: number },
    readonly failureReason: string,
    options?: { cause?: unknown },
  ) {
    super(
      `logs query failed on chunk [${failedRange.fromMs}..${failedRange.toMs}] ` +
        `after collecting ${partialResult.events.length} event(s): ${failureReason}`,
      options,
    );
    this.name = "PartialLogsQueryError";
  }
}

// Fetch log events from fromMs through positive-width chunks ending no later than toMs,
// splitting the span into <=1-hour queries (to dodge the query-time adaptive sampling above)
// and paging each chunk via the cursor until a short page signals exhaustion. Adjacent chunks
// have no gap or overlap - each ends 1 ms before the next begins. When toMs is exactly the
// next chunk boundary, the chunk before it reaches toMs instead (windowEnd), since the API
// rejects the point-width [toMs, toMs] request. The keyset-cursor + sealed/in-progress reasoning in the
// file header holds within each chunk. Each chunk goes through queryWindowNarrowing, so a
// chunk that comes back sampled is retried and, if still sampled, re-queried at narrower
// sub-windows before its result folds in here.
export async function queryLogEvents(
  config: LogsQueryConfig,
): Promise<LogsQueryResult> {
  if (config.onPage === undefined) {
    return queryLogEventsTuned(config);
  }
  const result = await queryLogEventsTuned({
    ...config,
    samplingRetries: 0,
    narrowWidthsMs: [],
  });
  // A single pass spends no heal budget at all, so sampling it saw was never
  // healed: unresolved, which is what the flag tells samplingFailure, and not
  // the floor-survived verdict a false flag would give.
  return result.maxAbrLevel > 1
    ? { ...result, healBudgetExhausted: true }
    : result;
}

// queryLogEvents with its internal settings exposed, for the tests.
export async function queryLogEventsTuned(
  config: TunedConfig,
): Promise<LogsQueryResult> {
  // An empty, reversed or non-numeric window would send no request and come back
  // as a complete read of nothing.
  if (
    !Number.isFinite(config.fromMs) ||
    !Number.isFinite(config.toMs) ||
    config.fromMs >= config.toMs
  ) {
    throw new Error(
      `logs query window must have fromMs before toMs, got [${config.fromMs}..${config.toMs}]`,
    );
  }
  const chunkMs = config.chunkMs ?? DEFAULT_CHUNK_MS;
  const narrowWidths = config.narrowWidthsMs ?? DEFAULT_NARROW_WIDTHS_MS;
  if (config.onPage !== undefined && narrowWidths.length > 0) {
    throw new Error(
      "onPage requires narrowWidthsMs: [] - narrowing discards pages a fold cannot take back",
    );
  }
  const events: unknown[] = [];
  let maxAbrLevel = 1;
  let healBudgetExhausted = false;
  // The Cloudflare "first hit in a session" flake is retried once - but only on the very
  // first request of the run (the first chunk's first page); later requests ride a warm
  // session.
  let firstChunk = true;
  for (
    let chunkFrom = config.fromMs;
    chunkFrom < config.toMs;
    chunkFrom += chunkMs
  ) {
    const chunkTo = windowEnd(chunkFrom, chunkMs, config.toMs);
    let chunk: LogsQueryResult;
    try {
      chunk = await queryWindowNarrowing(
        config,
        chunkFrom,
        chunkTo,
        firstChunk,
        narrowWidths,
      );
    } catch (error) {
      // Completed chunks are still the best evidence available to a diagnostic
      // caller, while throwing keeps an incomplete read from looking successful.
      if (events.length === 0) {
        throw error;
      }
      const failureReason =
        error instanceof Error ? error.message : String(error);
      throw new PartialLogsQueryError(
        { events, maxAbrLevel, healBudgetExhausted },
        { fromMs: chunkFrom, toMs: chunkTo },
        failureReason,
        { cause: error },
      );
    }
    appendAll(events, chunk.events);
    maxAbrLevel = worseAbrLevel(maxAbrLevel, chunk.maxAbrLevel);
    healBudgetExhausted = healBudgetExhausted || chunk.healBudgetExhausted;
    firstChunk = false;
  }
  return { events, maxAbrLevel, healBudgetExhausted };
}

// Query one [fromMs, toMs] window, escalating from same-window retry to window-narrowing when
// sampling persists. queryWindow paginates the window with its per-page same-window retry; if
// the window still comes back downsampled (maxAbrLevel > 1) and a narrower width is left in
// `narrowWidths`, the window is RE-QUERIED tiled at that next width (the sampled attempt's
// events are discarded - adjacent positive-width sub-windows replace them, the last reaching
// toMs as windowEnd says), recursing per sub-window. A window that
// reaches full resolution (or ABR_LEVEL_UNKNOWN, which is <= 1 and never narrows - a drifted
// shape will not heal by narrowing) or runs out of widths returns as-is; a still-sampled return
// at the 1-min floor is the incomplete read the caller fails on. `applyFirstHitRetry` rides
// only the very first request of the run (the top chunk's first page); sub-window re-queries run
// on the warm session.
async function queryWindowNarrowing(
  config: TunedConfig,
  fromMs: number,
  toMs: number,
  applyFirstHitRetry: boolean,
  narrowWidths: number[],
): Promise<LogsQueryResult> {
  const result = await queryWindow(config, fromMs, toMs, applyFirstHitRetry);
  const [width, ...rest] = narrowWidths;
  // No narrowing when the window is already full resolution (maxAbrLevel <= 1 - which also
  // covers ABR_LEVEL_UNKNOWN at -1, the drifted-shape case that fails closed without narrowing)
  // or there is no narrower width left to try. `width === undefined` IS the "ladder spent" check
  // and narrows width to a number for the loop below. result carries its own healBudgetExhausted
  // (e.g. a same-window retry that the budget cut short at the floor), so returning it as-is keeps
  // that signal.
  if (result.maxAbrLevel <= 1 || width === undefined) {
    return result;
  }
  // Heal budget spent: do NOT fan this window out into sub-windows (the expensive rung). Return
  // the sampled full-window result as-is - its events are kept, and its abr_level > 1
  // propagates so the read still reports itself incomplete. Mark healBudgetExhausted
  // so the caller reports the sampling UNRESOLVED (the floor was never reached), not proven volume.
  // This is the bound that keeps a heavily-sampled day from running narrowing for many minutes and
  // the caller being killed before it can keep and report what it read. Later chunks past the
  // deadline still get their one base pass in queryLogEvents, so no hour is dropped.
  if (pastHealDeadline(config)) {
    console.warn(
      `[workers-logs-reader] heal-budget deadline reached on window [${fromMs}..${toMs}] ` +
        `(abr_level=${result.maxAbrLevel}) - accepting the sampled window without narrowing; ` +
        `the read will report itself incomplete (cause unresolved)`,
    );
    return { ...result, healBudgetExhausted: true };
  }
  console.warn(
    `[workers-logs-reader] window [${fromMs}..${toMs}] still adaptively sampled ` +
      `(abr_level=${result.maxAbrLevel}) after same-window retries - narrowing to ${width}ms ` +
      `sub-windows and re-querying`,
  );
  const events: unknown[] = [];
  let maxAbrLevel = 1;
  // Fresh accumulator: the sub-windows REPLACE the discarded sampled attempt. Reaching this point
  // means pastHealDeadline was false, so result.healBudgetExhausted is necessarily false too (the
  // monotonic clock has not crossed the deadline) - nothing to carry from the discarded attempt.
  let healBudgetExhausted = false;
  for (let subFrom = fromMs; subFrom < toMs; subFrom += width) {
    const subTo = windowEnd(subFrom, width, toMs);
    const sub = await queryWindowNarrowing(config, subFrom, subTo, false, rest);
    appendAll(events, sub.events);
    maxAbrLevel = worseAbrLevel(maxAbrLevel, sub.maxAbrLevel);
    healBudgetExhausted = healBudgetExhausted || sub.healBudgetExhausted;
  }
  return { events, maxAbrLevel, healBudgetExhausted };
}

// Page one [fromMs, toMs] chunk to exhaustion, returning its events and the highest
// abr_level any of its pages reported. `applyFirstHitRetry` gates the one-time
// control-plane-flake retry to the run's very first request.
async function queryWindow(
  config: TunedConfig,
  fromMs: number,
  toMs: number,
  applyFirstHitRetry: boolean,
): Promise<LogsQueryResult> {
  const pageLimit = config.pageLimit ?? DEFAULT_PAGE_LIMIT;
  const maxPages = config.maxPages ?? DEFAULT_MAX_PAGES;

  const events: unknown[] = [];
  let maxAbrLevel = 1;
  let healBudgetExhausted = false;
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const fetched = await fetchPageResolvingSampling(
      config,
      fromMs,
      toMs,
      pageLimit,
      cursor,
      applyFirstHitRetry && page === 0,
    );
    const parsed = fetched.parsed;
    if (config.onPage !== undefined) {
      config.onPage(parsed.events);
    } else {
      appendAll(events, parsed.events);
    }
    // worseAbrLevel, not Math.max: parsed.abrLevel is ABR_LEVEL_UNKNOWN (-1) on an
    // unreadable page, which must dominate (fail closed), not lose to a numeric level.
    maxAbrLevel = worseAbrLevel(maxAbrLevel, parsed.abrLevel);
    healBudgetExhausted = healBudgetExhausted || fetched.healBudgetExhausted;

    // A short page (fewer than the limit) means there is nothing more to fetch right now.
    // For a sealed window (a day already over) that is permanent exhaustion - no event can
    // land inside an already-finished UTC day. For an in-progress window (the day
    // still under way) it is exhaustion as of now: events arriving later in the
    // still-open day are simply not in this capture, the accepted soft trailing edge
    // documented in the file header. Either way the paginator stops here; a full page
    // means there may be more.
    if (parsed.events.length < pageLimit) {
      return { events, maxAbrLevel, healBudgetExhausted };
    }
    if (!parsed.cursor) {
      // Full page but no cursor to advance: paging again would re-fetch the same page
      // forever. Surface rather than silently truncate the read.
      throw new Error(
        `logs query returned a full page (${pageLimit}) with no cursor to continue - cannot guarantee a complete read`,
      );
    }
    cursor = parsed.cursor;
    if (config.interPageDelayMs) {
      await config.sleep(config.interPageDelayMs);
    }
  }
  throw new Error(
    `logs query did not exhaust a chunk within ${maxPages} pages - an hour's volume may exceed the supported size (chunk-narrowing or Logpush graduation overdue?)`,
  );
}

// Fetch one page, then - if Cloudflare answered it with adaptive sampling (abr_level > 1) -
// re-issue the SAME page-query (same window + cursor, idempotent under the keyset cursor) up to
// `samplingRetries` times with exponential backoff, hoping a retry lands at full resolution.
// The first attempt carries the one-time first-hit-flake retry when `applyFirstHitRetry` is set
// (page 0 of the run); the sampling retries ride the now-warm session, so they use the plain
// fetch. Only abr_level > 1 is retried: ABR_LEVEL_UNKNOWN means the response shape drifted,
// which a retry cannot heal, so that page returns immediately and fails closed upstream. When the
// retries are spent the last (still-sampled) page is handed back to the caller's window-narrowing
// rung (queryWindowNarrowing), which re-queries the span at narrower sub-windows and usually
// recovers full resolution; only if narrowing ALSO cannot heal it does the read come back
// incomplete. The retry only adds a recovery chance, it never weakens the completeness gate.
async function fetchPageResolvingSampling(
  config: TunedConfig,
  fromMs: number,
  toMs: number,
  pageLimit: number,
  cursor: string | undefined,
  applyFirstHitRetry: boolean,
): Promise<{
  parsed: ReturnType<typeof interpretQueryResponse>;
  // True when the heal budget cut the same-window retries short - the page is still sampled
  // (abr_level > 1) but no further retry was made because now() reached healDeadlineMs. Propagated
  // up so the caller reports the sampling UNRESOLVED (cut short), not proven volume.
  healBudgetExhausted: boolean;
}> {
  let parsed = applyFirstHitRetry
    ? await fetchPageWithFirstHitRetry(config, fromMs, toMs, pageLimit, cursor)
    : await fetchPage(config, fromMs, toMs, pageLimit, cursor);

  const retries = config.samplingRetries ?? DEFAULT_SAMPLING_RETRIES;
  const backoffMs = config.samplingBackoffMs ?? DEFAULT_SAMPLING_BACKOFF_MS;
  let healBudgetExhausted = false;
  for (let attempt = 1; attempt <= retries && parsed.abrLevel > 1; attempt++) {
    // Stop spending backoff once the heal budget is gone - the page has already been fetched, so
    // its (sampled) events are in hand; accept them as incomplete rather than sleep past the
    // caller's time limit. Checked before the sleep so no new backoff starts past the deadline.
    if (pastHealDeadline(config)) {
      console.warn(
        `[workers-logs-reader] heal-budget deadline reached on window [${fromMs}..${toMs}] ` +
          `(abr_level=${parsed.abrLevel}) - accepting the sampled page without further ` +
          `same-window retries (cause unresolved)`,
      );
      healBudgetExhausted = true;
      break;
    }
    const delayMs = backoffMs * 2 ** (attempt - 1);
    console.warn(
      `[workers-logs-reader] query adaptively sampled (abr_level=${parsed.abrLevel}) on window ` +
        `[${fromMs}..${toMs}] - retry ${attempt}/${retries} after ${delayMs}ms backoff`,
    );
    await config.sleep(delayMs);
    parsed = await fetchPage(config, fromMs, toMs, pageLimit, cursor);
  }
  // Same-window retries are spent and the page is still sampled. This rung cannot see whether the
  // window-narrowing rung above (queryWindowNarrowing) will heal it - narrowing re-queries the span
  // at 10-min then 1-min sub-windows and in practice usually recovers full resolution - so this line
  // states only what it observed and never predicts the read's outcome; the verdict is the
  // caller's, from the result.
  // Skipped when the heal budget cut the retries short: that path logged its own give-up above, and
  // "after N retries" would misstate a count it never reached.
  if (parsed.abrLevel > 1 && !healBudgetExhausted) {
    console.warn(
      `[workers-logs-reader] window [${fromMs}..${toMs}] still adaptively sampled ` +
        `(abr_level=${parsed.abrLevel}) after ${retries} same-window ` +
        `${retries === 1 ? "retry" : "retries"} - the window-narrowing rung re-queries narrower if a ` +
        `width remains, else the read reports itself incomplete`,
    );
  }
  return { parsed, healBudgetExhausted };
}

async function fetchPageWithFirstHitRetry(
  config: TunedConfig,
  fromMs: number,
  toMs: number,
  pageLimit: number,
  cursor: string | undefined,
): Promise<ReturnType<typeof interpretQueryResponse>> {
  try {
    return await fetchPage(config, fromMs, toMs, pageLimit, cursor);
  } catch (err) {
    if (!isCloudflareFirstHitFlake(err)) {
      throw err;
    }
    console.warn(
      `[workers-logs-reader] query first-hit Cloudflare flake - retrying once: ${failureClass(err)}`,
    );
    return await fetchPage(config, fromMs, toMs, pageLimit, cursor);
  }
}

// What a retried failure was, for the warning: its HTTP status or its kind, never its
// message. A failed response's body, which the thrown error carries in full, can echo
// the query and its needle, and a warning goes to the caller's log whether or not the
// caller ever handles the error.
function failureClass(err: unknown): string {
  if (err instanceof LogsQueryHttpError) {
    return `HTTP ${err.status}`;
  }
  if (err instanceof LogsQueryTransportError) {
    return "no response, or a body that could not be read";
  }
  return err instanceof Error ? err.name : "unknown failure";
}

// The inclusive end of the window starting at `from` that is `width` ms wide and stops at
// `to`. When the window after it would hold only `to` itself, this one reaches `to`
// instead: the API rejects a point-width window, and a window left out is events lost.
function windowEnd(from: number, width: number, to: number): number {
  const end = Math.min(from + width - 1, to);
  return end + 1 === to ? to : end;
}

// Appended one at a time: spreading a chunk's events into push() passes each as an
// argument, and an hour can hold more events than an engine accepts arguments.
function appendAll(into: unknown[], from: readonly unknown[]): void {
  for (const event of from) {
    into.push(event);
  }
}

// True when `err` is a transient control-plane failure worth re-issuing on this idempotent query:
// a transport error (no response at all), or an HTTP status in the transient allowlist. A
// non-transient HTTP status (4xx but 429) or any other thrown error - an envelope success=false or a
// shape error from interpretQueryResponse - is a definitive verdict and returns false so it fails loud.
function isTransientQueryError(err: unknown): boolean {
  if (err instanceof LogsQueryTransportError) {
    return true;
  }
  if (err instanceof LogsQueryHttpError) {
    return isTransientStatus(err.status);
  }
  return false;
}

// Fetch one page, re-issuing it on a transient control-plane failure (see isTransientQueryError)
// with exponential backoff - the lowest retry rung, below fetchPageResolvingSampling's abr_level
// retry. Bounded by transientRetries AND healDeadlineMs: past either, the last error is rethrown so
// the run fails (a failed fetch, unlike a sampled page, leaves no page result to keep; the outer
// traversal can still preserve completed chunks). The deadline is checked before the backoff sleep
// so no new backoff starts past it. Every page fetch in the run flows through here - page 0 (under
// the first-hit wrapper), sampling re-fetches, and narrowing sub-windows alike - so the whole
// fan-out inherits transient resilience uniformly.
async function fetchPage(
  config: TunedConfig,
  fromMs: number,
  toMs: number,
  pageLimit: number,
  cursor: string | undefined,
): Promise<ReturnType<typeof interpretQueryResponse>> {
  const retries = config.transientRetries ?? DEFAULT_TRANSIENT_RETRIES;
  const backoffMs = config.transientBackoffMs ?? DEFAULT_TRANSIENT_BACKOFF_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchPageOnce(config, fromMs, toMs, pageLimit, cursor);
    } catch (err) {
      if (
        !isTransientQueryError(err) ||
        attempt >= retries ||
        pastHealDeadline(config)
      ) {
        throw err;
      }
      const delayMs = backoffMs * 2 ** attempt;
      console.warn(
        `[workers-logs-reader] query transient failure on window [${fromMs}..${toMs}] - ` +
          `retry ${attempt + 1}/${retries} after ${delayMs}ms backoff: ${failureClass(err)}`,
      );
      await config.sleep(delayMs);
    }
  }
}

async function fetchPageOnce(
  config: TunedConfig,
  fromMs: number,
  toMs: number,
  pageLimit: number,
  cursor: string | undefined,
): Promise<ReturnType<typeof interpretQueryResponse>> {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${config.accountId}` +
    `/workers/observability/telemetry/query`;
  // `parameters.datasets` is required for an ad-hoc query - without it the API
  // tries to resolve `queryId` as a saved query and returns "Query not found".
  // The query is account-wide and window-scoped only (timeframe + dataset, NO
  // filters): every Worker's events in the window come in one stream, which
  // events.ts partitionEventsByService can split afterward. No service or
  // invocation-type filter - either would silently drop whole Workers or drop the
  // cron/Durable Object events. `config.needle` is the one narrowing the API
  // applies, and only a caller asking a narrower question sets it.
  const body: Record<string, unknown> = {
    // A label only: with `parameters` given inline, the API runs the query as
    // sent and does not look the id up.
    queryId: "workers-logs-reader",
    view: "events",
    limit: pageLimit,
    // The per-chunk sub-window, not the full day - a narrow window is what holds the
    // query at abr_level=1 (full resolution). See queryLogEvents.
    timeframe: { from: fromMs, to: toMs },
    parameters: {
      datasets: [config.dataset ?? DATASET],
      ...(config.needle !== undefined
        ? { needle: { value: config.needle, isRegex: false, matchCase: true } }
        : {}),
    },
  };
  if (cursor) {
    body.offset = cursor;
    body.offsetDirection = "next";
  }
  let response: Response;
  try {
    response = await config.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // The fetch never produced a response (connection reset/refused, DNS blip, TLS/socket timeout).
    // Tag it transport-class so the retry layer can re-issue this idempotent query.
    throw new LogsQueryTransportError(
      `logs query request failed - ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (!response.ok) {
    const text = await safeReadText(response);
    throw new LogsQueryHttpError(
      response.status,
      `logs query HTTP ${response.status} ${response.statusText} - ${text}`,
    );
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    // A 2xx whose body could not be read or JSON-decoded is a truncated/garbled stream - a
    // transport-class blip, not a stable API verdict - so it joins the transient-retry set rather
    // than failing the run outright.
    throw new LogsQueryTransportError(
      `logs query response body unreadable - ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  return interpretQueryResponse(json);
}
