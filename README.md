# decision-gate

The one gate Node tools pass through to spend a user's key on a decision model.
It decides whether a request may be sent (key, never-send check, spend ceilings, rate limit), sends it through the provider's own SDK, and records what it cost.
Unofficial; not affiliated with TypeSafe.

Tools that share a key on one machine share its daily ceiling, and every key on one TypeSafe account shares that account's rate window, because every tool reads and writes the same local state.
Nothing here calls a generative model, stores request text or runs at development time; those belong to the tools themselves.
The interface is 0.x: a breaking change raises the minor version.

```js
import { openJev, PINNED_MODEL } from "decision-gate";

const jev = openJev({ tool: "my-tool" }); // TYPESAFE_API_KEY is enough
const run = jev.run({ capUsd: 0.02 });
try {
  const answer = await run.ask({
    model: PINNED_MODEL,
    state: { text: "public example" },
    questions: {
      useful: { type: "noul", instructions: "Is the text useful?" }
    }
  });
  console.log(answer.answers.useful.noul);
} finally {
  await run.close();
}
```

## Opening the gate

`openJev({ tool, key, neverSend, spend, env, notice, fetch })` opens a caller.
`tool` is required: a short identifier such as `herdr-find` that tags the caller's spend records, not a different service.
`notice` receives one-line warnings and defaults to a no-op.
`spend` accepts `perRunUsd` and `perDayUsd`, defaulting to the config's USD 0.02 and USD 0.20.
The config's daily ceiling covers the key across every tool that uses it; a caller's `perDayUsd` can only lower what that tool spends, never add to the key's.
`fetch` replaces the network for tests; the destination is still checked.

The returned object holds `status()`, `config`, `redactor`, `remaining()`, `cache()` and `run()`.
`remaining()` resolves to what is left of today's ceiling for this tool on this key.

## Key sources

Key precedence is an explicit `key: { file }`, `{ env }` or `{ value }`, then `TYPESAFE_API_KEY`, then the config's `key_file`.
Exactly one explicit source is allowed, and no other credential location is guessed.
Key files must be regular, nonempty files with mode 600.
`jev.status()` returns `{ ok: true }` or `{ ok: false, reason }` without reading the contents of a key file; `missing: true` marks the case where no key source is configured at all.
A status check cannot establish whether the service will accept a credential.
The key is read when a request or remaining-budget lookup first needs its fingerprint, and it is never enumerable, logged or stored.

## Configuration

The one config file is `$XDG_CONFIG_HOME/decision-gate/config.json`, normally `~/.config/decision-gate/config.json`.
`DECISION_GATE_CONFIG` overrides that location.
No file is required.

```json
{
  "key_file": "~/.config/decision-gate/key",
  "never_send_file": "~/.config/decision-gate/never-send.json",
  "spend": { "per_run_usd": 0.02, "per_day_usd": 0.2 },
  "limits": {
    "requests_per_minute": 1200,
    "tokens_per_second": 250000,
    "share": 0.8,
    "in_flight": 4
  }
}
```

`DECISION_GATE_PER_RUN_USD`, `DECISION_GATE_PER_DAY_USD`, `DECISION_GATE_RPM`, `DECISION_GATE_TPS`, `DECISION_GATE_IN_FLIGHT` and `DECISION_GATE_NEVER_SEND_FILE` override the corresponding config values.
Relative paths in the file resolve beside it, and `~/` works.
Every tool reads the same limits section and daily ceiling; an explicit caller per-run ceiling remains the caller's own.

## Accounts and rate limits

TypeSafe counts rate limits per account, not per key.
A second key on the same account adds no capacity: measured on one account, small requests got about 47,000-56,000 tokens a second on one key and 46,000 combined on two, and large ones about 121,000 on one and 127,000 split across two.
A key per tool is for separate spend records and revocation, not for throughput.

A key does not reveal its account, so the gate assumes every key on this machine belongs to one account.
Every key shares that account's one rate window, one 429 pause and one set of in-flight requests, across every tool and process on the machine.

`limits` describes the account's ceiling:

- `requests_per_minute` and `tokens_per_second` are TypeSafe's published limits for the pinned model; the gate keeps to `share` of both.
- `in_flight` is how many requests the account may have open at once, 4 by default.

Only one large request, estimated at 32,000 tokens or more, is open at a time; that is fixed, not configured.

The defaults are measured: requests of about 6,100 tokens finished fastest with two to four in flight, and requests of about 50,000 tokens finished as fast one at a time as two or four at once.
A tool that sends requests in parallel should size its pool from `jev.config.limits.inFlight` instead of keeping its own setting, since the gate holds any extra requests until a slot frees.

## Runs

```js
const run = jev.run({ capUsd });
await run.ask(request, { signal });
run.summary();
await run.close();
```

`capUsd` can lower the per-run ceiling, never raise it.
Raw requests are checked, not silently rewritten: a forbidden value in any serialized field or its decoded JSON form prevents the request.
Callers that send user text redact it first with `jev.redactor.redact`, and `jev.redactor.check(body)` runs the same final check on a serialized request before anything is queued.
`jev.redactor.clean(text)` is true when one piece of text would pass that check as a string in a request: nothing forbidden survives in it and the built-in rules would leave it unchanged.
A caller batching many texts into one request can use it on each redacted text to hold back only the ones the check would refuse, instead of losing the whole request.
Built-in rules cover known secret formats and email addresses, not arbitrary long hashes or random-looking strings, so file paths reach the service unchanged.
`privateKeyLines(lines)` maps each line of a private key piped in as separate lines to its redacted form, since such a key is only recognisable across lines.
A private optional never-send file adds user rules and forbidden patterns:

```json
{
  "rules": [["person", "(?i)Example Person", "[person]"]],
  "forbidden": ["(?i)Example Person"]
}
```

Await `close()` to replace the run's hold with its committed cost.
`summary()` reports reserved and billed USD and billed input tokens without storing text.
Its `ceiling` is `"day"` when what is left of today bounds the run and `"run"` otherwise.
Asks within one run may overlap: when the run's ceiling is full, an attempt waits for another to settle and is refused with a `SpendCapError` only when none is in flight.
`close()` waits for asks already made before it records the run's cost.
Use `describeError` for a safe diagnostic instead of logging a transport exception or provider response body.
The errors it passes through are `ConfigError`, `ServiceError` (with the HTTP `status`), `SpendCapError`, `RedactionError` and `StateError`.

`PINNED_MODEL`, `MAX_INPUT_TOKENS`, `usdFor(tokens)` and `estimateUsd(bytes)` describe the pinned model's request limit and price.
`estimateUsd` uses the measured rate of about a quarter token per byte, for figures shown before a run; it is not a reservation.

## Answer cache

```js
const cache = jev.cache({ scope: { prompt: "line-v1", query }, enabled: true });
cache.get(key); // a probability, or undefined
await cache.put([[key, 0.93]]);
```

The cache stores probabilities under caller-supplied string keys, and never the keys themselves.
Each key is stored as an HMAC under a private random key, so short keys such as source lines cannot be guessed from the stored hashes.
Entries are filed by the caller's `scope` together with the provider, model, endpoint and never-send list, so changing any of them starts a fresh file.
Entries hold only key hashes, probabilities and times.
They expire after 30 days, a file mostly made of expired or superseded rows is rewritten on its next write, and files are evicted to keep the cache within 50 MiB.
A cache that cannot be read or written warns once through `notice` and continues without caching, not without spend accounting.

## Request ownership and persisted state

The official `@typesafe-ai/sdk` owns serialization, timeouts, retries and Retry-After parsing.
The gate explicitly sets its key, destination, model and logging level, so SDK environment defaults cannot redirect or log requests.
Before the SDK starts a request's first attempt, the gate waits for room under the run's ceiling and for one of the account's in-flight slots, so a queued request never uses up its attempt's 30-second timeout.
The slot is held until the request settles, across the SDK's retries.
Its fetch wrapper checks the exact body, reserves the attempt against the run's ceiling, counts it in the account's rate window and persists the reservation before every network attempt, including retries.
A refusal known not to be billed, such as a 429, hands its reservation to the retry, so the retry needs no new room.
A retry after an attempt that may have been billed reserves afresh without waiting; if it does not fit, that request fails as a service error, and only booked plus held spend reaching the ceiling stops a run at its ceiling.
A retry that waits out the rate window past its timeout is a timeout the SDK may retry.
Redirects are never followed.
A 429 or 529 records a pause for the whole account using the server's Retry-After delay, or a short fallback when absent, before SDK retry handling continues.
For tests only, `DECISION_GATE_ENDPOINT` may point at an HTTP URL on `127.0.0.1` or `::1`; any other host is refused.

State lives under `$XDG_STATE_HOME/decision-gate`, normally `~/.local/state/decision-gate`, and the cache under `$XDG_CACHE_HOME/decision-gate/answers`:

| Path | Holds |
| --- | --- |
| `cache-key` | The answer cache's private hash key |
| `spend/typesafe/<key-fingerprint>.jsonl` | The cost ledger: tool, time, hold and cost of each run, never text |
| `limits/typesafe/accounts/default.json` | The account's shared rate window, pause and in-flight requests |

The fingerprint is the first 16 SHA-256 hex characters, never the key.
Rate requests use a rolling minute window; tokens use a rolling second window, counting each request at its size in bytes, up to the request limit.
Measured usage is about a quarter token per byte, so this overcounts; the spend ceiling, not the limiter, is the guaranteed bound.
The defaults enforce 960 requests a minute and 200,000 reserved tokens a second.
An in-flight request whose process stopped without releasing it is dropped once that process is gone, or after two minutes without an attempt.
If the limiter's directory cannot be written, it warns once per limiter and uses in-process limits.
This does not disable the daily ceiling: unwritable spend state still refuses paid requests.

The daily ceiling counts every tool's records on the key, so tools sharing a key cannot together pass it.
A run reserves its allowance under a short filesystem lock so concurrent runs cannot allocate the same daily balance.
The daily boundary is UTC midnight.
Unused holds expire after ten minutes; booked attempts remain charged after a crash.
A resumed stale hold re-checks capacity before further spending.
The ledger keeps only today's and yesterday's records once older or superseded rows outnumber them.

Each read-modify-write of local state takes a lock directory for microseconds, never across a network call or sleep.
The lock is published with its owner already inside, so a crash cannot leave an ownerless lock.
A lock whose owner process is gone, or that is older than 30 seconds, is moved aside under a name tied to that owner, so two processes reclaiming the same stale lock cannot remove a newer one.

The reservation uses the pinned model's full documented request limit of 65,536 tokens (`MAX_INPUT_TOKENS`), not an empirical bytes-per-token ratio.
That figure is being checked: a third-party report puts the real limit nearer 32k, and the constant changes only once that check reports.
Successful responses replace the reservation with reported input usage.
An uncertain attempt remains booked at its reservation.
This can refuse a very small allowance even when a displayed estimate is lower.

## Providers and dependency review

Only native TypeSafe is implemented.
A provider keeps its name, key variable, pinned model, price, endpoint and SDK responder together, and its state is filed under its name, so adding one needs no migration.
Another provider needs a known price, where zero counts for a local model, and comparable typed probabilities before it can support these ceilings and callers' thresholds.

The pinned `@typesafe-ai/sdk` version is 0.6.0, with no runtime dependencies or install hooks.
Its published ESM entry point was inspected for credentials, logging, HTTP destinations, retries and filesystem or execution side effects.
SDK logging is explicitly off because debug logging can include request bodies.
All local state and key-file access belong to decision-gate.
