# workers-logs-reader

Read a window of Cloudflare Workers Observability events, a whole UTC day of
every Worker in an account for instance, from the telemetry query API, paged to
the end, and know whether what came back is complete.

## What it is

A TypeScript library with no runtime dependency. Its one call, `queryLogEvents`,
reads every event in a time window through Cloudflare's
[telemetry query API](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/):

- in one-hour chunks, each paged to exhaustion with the API's keyset cursor;
- with a sampled page re-read, and a chunk still sampled re-read in 10-minute
  and then 1-minute pieces;
- with transient failures (429, 5xx, a dropped connection) retried with backoff;
- all of the healing under a deadline you set, so a bad day ends inside your own
  time limit with what was read rather than being killed part-way.

It returns the events and the worst sampling level any page reported, and
`samplingFailure` turns that level into a one-line verdict: `null` for a
complete read, or why it is not. A few helpers sit beside it: the UTC day as a
window, events grouped by the Worker that emitted them, and newline-delimited
JSON.

## Why it exists

Workers Logs keeps events for 7 days on the Workers Paid plan and 3 on Free
([Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)).
Keeping them longer means copying them out. The direct way to do that is
[Workers Logpush](https://developers.cloudflare.com/workers/observability/logs/logpush/),
which pushes each Worker's trace events to a destination such as R2. It needs
the Paid plan and `logpush = true` on each Worker, and it starts from when you
turn it on. If that fits, use it.

Reading the events back through the telemetry query API instead needs nothing
enabled on the Workers and can reach any day still inside the retention window.
But a naive read is quietly incomplete:

- **The API samples by query cost.** A query over a whole day is answered from a
  downsampled copy: one was seen at `result.statistics.abr_level` 10, about one
  event in ten, while the same day read an hour at a time came back at 1, full
  resolution. Nothing else in the response says the events are a subset.
- **Paging must follow the cursor to the end.** A page holds at most the limit
  you ask for, and a day of a busy account is many pages.
- **The control plane has bad moments.** A single 503, or the 401 a fresh token
  can get on its first call, should not cost a day.

This package reads in hours, re-reads what came back sampled, narrows what stays
sampled, and reports the sampling level it ends with, so a caller can refuse to
call a sampled read complete. It reads `abr_level` as the API returns it, and
treats a page without a positive `abr_level` as incomplete rather than as full
resolution.

## How to use it

### Install

The package is published as a GitHub release asset, not on the npm registry. It
ships TypeScript source, so it needs a runtime or bundler that compiles
TypeScript, such as Bun:

```sh
bun add https://github.com/curlewlabs-com/workers-logs-reader/releases/download/v0.1.0/curlewlabs-com-workers-logs-reader-0.1.0.tgz
```

The lockfile records the tarball's integrity, and each release is immutable.

### Read a day

```ts
import {
  queryLogEvents,
  samplingFailure,
  utcDayWindow,
} from "@curlewlabs-com/workers-logs-reader";

const day = utcDayWindow(Date.now()); // the UTC day before now
const result = await queryLogEvents({
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
  apiToken: process.env.CLOUDFLARE_API_TOKEN!,
  fromMs: day.fromMs,
  toMs: day.toMs,
  fetchImpl: fetch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => performance.now(),
  healDeadlineMs: performance.now() + 20 * 60 * 1000,
});

const failure = samplingFailure(result.maxAbrLevel, result.healBudgetExhausted);
if (failure !== null) {
  // The events are a subset. Keep them if you like, but not as the whole day.
  console.error(failure);
}
```

`partitionEventsByService(result.events)` groups the events by the Worker that
emitted them, and `eventsToNdjson(events)` writes them one per line, ready to
compress and store.

### The token

The token needs to read the account's Workers Observability data. A token with
the account permission Workers Observability Read has been enough for these
queries; Cloudflare's API reference lists Workers Observability Write as the
accepted permission for the endpoint. The token goes only to
`api.cloudflare.com`, as a bearer header.

### Options

`queryLogEvents` takes, besides the window:

| Option                  | Why it exists                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `accountId`, `apiToken` | Every call names the account and carries a token.                                                                                                                                                                                                                                                                                                                |
| `fetchImpl`, `sleep`    | The package makes no call and waits on no timer of its own: it runs wherever you can hand it a `fetch`, and tests run without the network.                                                                                                                                                                                                                       |
| `now`, `healDeadlineMs` | Healing a heavily sampled day can take many minutes. Past the deadline the read stops healing and returns what it has, marked incomplete; every chunk still gets its one pass, so no events are dropped for time. Set it inside whatever time limit you run within.                                                                                              |
| `needle` (optional)     | The API's own full-text match, for one request's or one identity's events out of a short window. Unset, every event is read.                                                                                                                                                                                                                                     |
| `dataset` (optional)    | The dataset to read: the Workers log events by default, or another the API holds, such as trace spans.                                                                                                                                                                                                                                                           |
| `onPage` (optional)     | For a caller that only folds the events, summing sizes or counting: each page goes to the callback and is not kept. The read is then a single pass, one request per page with no retry of a sampled page and no narrowing, so it costs one read of the window; `maxAbrLevel` still says whether any page was sampled, and a sampled read is reported unresolved. |

The chunk width, page size, retry counts, backoffs and narrowing widths are
fixed; the comments in `src/query-client.ts` say why each is what it is.

### What comes back

- `events`: every event read, in the API's order (newest first within a page,
  chunks in time order).
- `maxAbrLevel`: 1 if every page came back at full resolution; above 1 if any
  stayed sampled; `ABR_LEVEL_UNKNOWN` (-1) if any page had no usable level.
- `healBudgetExhausted`: whether healing was cut short, by the deadline or, with
  `onPage`, by not running at all. A sampled read with this set is unresolved,
  and reading again may come back complete. One without it stayed sampled down
  to 1-minute windows: the volume is more than a query can read at full
  resolution, and Logpush is the way forward.

A chunk that fails after earlier chunks succeeded throws
`PartialLogsQueryError`, which carries the events already read and the range
that failed. A failure before any event was read throws as itself.

## How it works

Paging is safe against the classic miss-or-duplicate bug of paging a table that
is being written: the cursor is the last event's `$metadata.id`, an immutable
id, not a row offset. A day that is over is also frozen, since no event can be
stamped inside it. A read of the day in progress gets the events that existed
when each page was read; `utcDayWindow` marks such a window `sealed: false`.

A sampled page is re-read twice, after 5 and 10 seconds. A chunk still sampled
after that is re-read as six 10-minute windows, and any of those still sampled
as ten 1-minute windows. A failed request (429, any 5xx, no response, or a body
that could not be read) is re-read up to five times, after 2, 4, 8, 16 and 32
seconds; any other status, or an answer with `success: false`, fails at once.
The first request of a read is also repeated once on the control plane's
first-call authentication flake.

The source files say why each step is what it is: `src/query-client.ts` for the
read, `src/abr.ts` for the sampling verdict.

## Requirements

- A runtime with `fetch` that compiles TypeScript, or a bundler in front of one.
  The tests run on Bun.

## Known issues

- **The heal deadline is checked before each wait, not before each request.** A
  retry whose wait began before the deadline still sends its request after it,
  the first-call authentication retry does not look at the deadline, and once a
  chunk starts narrowing, each of its narrower windows still gets its first read
  after the deadline passes. A read can therefore run past `healDeadlineMs` by
  one retry's request, or by the rest of one chunk's narrower reads; leave that
  much room under your own limit.

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option. Releases published under the MIT license alone may also be used
under either license.

### Contribution

By submitting a contribution for inclusion in this project, you agree that it is
dual licensed as above, without any additional terms or conditions.
