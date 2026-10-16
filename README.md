# decision-gate

> **Pre-1.0.**
> This is 0.2.0: the interface may change, and a breaking change raises the minor version.
> Unofficial; not affiliated with TypeSafe.

Built with Claude Code.

Rate and spend limits for code that calls Jev in a loop.

If you ask Jev the same kind of question many times, say a go/no-go on every new job posting for each of fifty students, three things go wrong at volume.
Requests start failing with `429`, and every caller that retries on its own schedule makes it worse.
The same posting and question get sent twice, and you pay twice.
And nothing stops a runaway loop before the bill does.

decision-gate is the one place your code sends a Jev request through.
It waits for room under the account's rate limit, pauses every caller together when the service says to slow down, checks the request against a daily spend ceiling for your key, sends it through TypeSafe's own SDK and records what it cost.
It also gives you an answer cache, so a question answered in an earlier run, or earlier in the same run, is not asked again.
It never calls a generative model and never stores request text.

## Quick start

```sh
npm install decision-gate
export TYPESAFE_API_KEY=...
```

```js
import { openJev } from "decision-gate";

const questions = {
  fit: { type: "noul", instructions: "Does this posting fit the student's skills and goals?" },
  eligible: { type: "noul", instructions: "Can the student apply, given the location and their graduation date?" }
};

const jev = openJev({ tool: "job-screen" });
// Rewording any question changes the scope, so no old answers are reused
const cache = jev.cache({ scope: { questions } });
// Each run is capped at spend.per_run_usd (USD 0.02 by default); open a run per batch for a long job
const run = jev.run();

async function screen(posting, student) {
  // Emails, known secret formats and authorization credentials are replaced before anything is sent or cached
  const state = { posting: jev.redactor.redact(posting), student: jev.redactor.redact(student) };
  const key = (name) => `${name}\n${JSON.stringify(state)}`;
  const result = Object.fromEntries(Object.keys(questions).map((name) => [name, cache.get(key(name))]));
  const missing = Object.keys(result).filter((name) => result[name] === undefined);
  if (missing.length) {
    // One request answers every missing question over the same state
    const answer = await run.ask({
      state,
      questions: Object.fromEntries(missing.map((name) => [name, questions[name]]))
    });
    for (const name of missing) result[name] = answer.answers[name].noul;
    await cache.put(missing.map((name) => [key(name), result[name]]));
  }
  return result;
}

try {
  console.log(await screen("Junior data analyst, Denver, hybrid...", "Senior, statistics major, graduates May 2027..."));
} finally {
  await run.close();
}
```

The request's `model` is optional.
It defaults to `jev-1.13.0`, exported as `PINNED_MODEL`.
The gate accepts only the exact versions `jev-1.13.0` and `jev-1.14.0`.
It refuses floating aliases such as `jev-latest` and `jev-preview`, provider wire IDs, and any other version.

## Selecting an exact Jev version

To use 1.14, set `model` when you open the caller, so its asks and its caches use 1.14 together:

```js
const jev = openJev({ tool: "job-screen", model: "jev-1.14.0", notice: console.error });
const cache = jev.cache({ scope: { questions } });
const run = jev.run();
try {
  const result = await run.ask({ state: "A public example", questions });
  console.log(result.model); // The exact provider model that answered
} finally {
  await run.close();
}
```

One ask can use a different version from its caller by setting `request.model`.
If you cache that ask's answers, open the cache with the same `model`: `jev.cache({ scope, model: "jev-1.14.0" })`.
A cache is tied to one version when you open it.
It does not follow later requests, and it does not check the probabilities you put in.
So never put an answer from one version into a cache opened for another.
Caches for different versions stay separate, even when their scope and keys are the same.
`PINNED_MODEL` still names 1.13, so existing imports keep working, and `ALLOWED_MODELS` exports the full list.
Each response keeps the exact model ID the provider returned, and the gate also reports that ID through `notice`, without any request text.
Thresholds tuned on 1.13 are not tuned for 1.14, so evaluate them again before you rely on them with 1.14.

## Preview Box

[Box](https://docs.typesafe.ai/primitives/box.md) finds one target in an image and returns its bounding box.
TypeSafe marks Box and image input as **not production-ready**, so their format, limits and accuracy can change.
To use Box, select `jev-1.14.0` and pass `{ previewBox: true }` on every ask that has a Box question.
The gate refuses Box on 1.13, and Box without that option, before it sends anything.
All three routes accept the preview request: native TypeSafe, Vercel AI Gateway and the ZDR OpenRouter route.

```js
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { openJev } from "decision-gate";

const jev = openJev({ tool: "box-prototype", model: "jev-1.14.0" });
const run = jev.run();
const photo = randomUUID();
try {
  const result = await run.ask({
    state: { photo },
    assets: { [photo]: { type: "image", format: "png", data_base64: readFileSync("photo.png").toString("base64") } },
    questions: {
      present: { type: "noul", instructions: "Is there a coffee mug in `photo`?" },
      mug: { type: "box", instructions: "the coffee mug in `photo`" }
    }
  }, { previewBox: true });
  console.log(result.model, result.answers.present.noul, result.answers.mug);
} finally {
  await run.close();
}
```

A Box answer looks like `{ type: "box", box: { top, bottom, left, right }, confidence }`.
Each edge and the confidence is a fraction from 0 to 1, with `top < bottom` and `left < right`.
Edges are measured from the top-left corner: `top` and `bottom` as a fraction of the image height, `left` and `right` as a fraction of its width.
The gate checks these bounds before it returns the answer.
Box takes `instructions`, not `criteria`, and it **has no not-found answer**: it returns a box even when the target is not in the image.
So ask a Noul presence question in the same request, as in the example, and use the box only when the Noul probability passes a threshold you have tested on your own images.
Both questions run in the same request: the Noul decides whether your code uses the box, but the model computes the box either way.

Only requests with an opted-in Box question carry the `TypeSafe-Danger-Zone-Images: true` header, and so do their retries.
Images go in the JSON `assets` field as base64 PNG or JPEG.
Multipart uploads, image URLs, SDK image objects and image-only Noul requests are not supported.
To ask a Noul question about an image, include it in a request with a Box question, as above.
Follow TypeSafe's [image preparation and limits](https://docs.typesafe.ai/images.md): a still PNG or JPEG, 280 to 1568 pixels on each side.
The gate estimates request size from bytes and counts base64 conservatively, so it can refuse an image the API would accept.
It cannot predict image token usage; the service still checks the real context limit.
Image input tokens appear in reported usage and are booked at the text price.
The answer cache holds single numbers from 0 to 1, so it cannot store a Box answer's coordinates; it will store a Box confidence only if you put that number in yourself.
Never-send checks read serialized text only.
They cannot see pixels or text inside base64 data, so remove sensitive content from an image before you send it.

## What it guarantees

**A `429` slows everyone down together instead of hammering.**
When TypeSafe answers `429` or `529`, the gate pauses every caller on the account, across every tool and process on the machine, for the server's `Retry-After` delay (one second when none is given).
The request that got it waits out that pause and is retried, after the server's delay or with exponential backoff when none is given, up to `maxRetries` times (2 by default).
Only then does the ask fail, with a `ServiceError` whose `status` is `429`.

**It keeps under the account's rate limit before the service has to say so.**
Requests wait for room under 80% (`limits.share`) of the account's `requests_per_minute` and `tokens_per_second`, at most 4 (`limits.in_flight`) are open at once, and a request of 32,000 tokens or more goes one at a time.
Every TypeSafe key on the machine shares these limits, because TypeSafe counts them per account, not per key.

**The same question over the same state is answered once.**
The answer cache stores each answer's probability under a key you choose, such as the question name plus the state, and `cache.get` returns it on the next ask instead of sending the request again.
Answers last 30 days, and changing the cache's `scope`, the model or the never-send list starts fresh.
The cache stores only keyed hashes and numbers, never the state or question text.
A cache sees every answer stored before it was opened plus its own `put`s, so it removes repeats across later runs and within a run.
It does not see answers another process stores after it was opened, so two processes screening at the same time, or a long-lived cache opened earlier, can each pay for the same question; open a fresh cache for each batch, or screen from one process.
It also does not merge two identical asks started at the same moment, so check the cache before sending a batch.

**A daily spend ceiling per key.**
Every tool on the machine that uses the same key shares one daily ceiling, `spend.per_day_usd` (USD 0.20 by default, reset at UTC midnight), and each run has its own ceiling, `spend.per_run_usd` (USD 0.02 by default).
A request that does not fit under them is not sent, and the ask fails with a `SpendCapError`.
At the recorded price for the pinned model, USD 0.042 per million input tokens with output free, the default daily ceiling covers about 4.7 million input tokens; raise it in the config for more.
The default run ceiling covers about 476,000, so a long screening job opens a run per batch or raises `per_run_usd` in the config too.

**Several questions over one state go in one call.**
A Jev request carries one `state` and any number of named `questions`, and the gate sends it as one request: one rate-limit slot, and the state's input tokens paid once however many questions it asks.
When the state is most of the request, as a job posting usually is, three questions in one call cost little more than one, and use a third of the requests.

**Forbidden text in a request is refused before it is sent.**
Every request is checked, including each retry, and one containing a forbidden text value is refused with a `RedactionError` rather than rewritten.
This check reads text only: it cannot see pixels or text inside base64 data, so remove sensitive content from preview images before they reach the gate.
The built-in rules cover known secret formats and email addresses.
They also rewrite the value after an `authorization`, `proxy-authorization` or `auth` key, as a header, a JSON or YAML key or a parameter, in only two shapes.
One is an HTTP authentication scheme, such as `Basic`, `Bearer`, `Token`, `Digest`, `Negotiate` or `AWS4-HMAC-SHA256`, followed by a credential, redacted with its parameters to the end of its quotes or line.
A credential there is an auth-parameter list such as `username="u"`, a placeholder an earlier rule wrote such as `[token]`, or a run with no spaces that is not a plain word: it holds a digit, a capital after its first letter or one of `+ / = . _ ~ -`, or is a single character.
The other is a token-shaped value: a run of 16 or more characters with no spaces that holds a letter and either a digit, a `+` or a trailing `=`.
Any other value is kept, so "work authorization: F-1 OPT", "Work Authorization: US citizen", "OPT-STEM-Extension", "PermanentResident" and a posting's "Authorization: must be authorized to work" or "Authorization: Signature required on the I-9" reach the service unchanged.
Redact text with `jev.redactor.redact` before putting it in a request.

## Using Jev through Vercel AI Gateway

> **Experimental route, pinned version.**
> The `vercel-ai-gateway` provider sends requests through Vercel AI Gateway instead of to TypeSafe directly.
> It sends `typesafe-ai/jev-1.13.0` by default, or `typesafe-ai/jev-1.14.0` when the caller selects 1.14.
> Both versioned IDs are in the [gateway catalog](https://ai-gateway.vercel.sh/v1/models), checked 2026-10-16.
> `jev.config.pinned` is `true`, and the gate no longer uses the floating `typesafe-ai/jev` ID.

Choose it by name, with `"provider": "vercel-ai-gateway"` in the config or `DECISION_GATE_PROVIDER=vercel-ai-gateway`, and export `AI_GATEWAY_API_KEY`.
The gate never picks a provider from whichever key variable happens to be set, since other tools export those keys for their own use.
The key is sent as a Bearer token only to `https://ai-gateway.vercel.sh/typesafe/v1/systemone`, with TypeSafe's request and answer shapes, so callers change nothing else.
A key belongs to one provider, so the gateway is never sent `TYPESAFE_API_KEY`, the top-level `key_file` or a caller's TypeSafe key; without a gateway key it refuses to send and names where one goes.

Spend is booked from the answer's reported input tokens at USD 0.042 per million input tokens, output free, in the gateway's own ledger with its own daily ceiling per key.
A `402` from the gateway fails the request with a `ServiceError` whose `status` is `402`.

Requests pass through Vercel, an added party on the data path.

The gateway gets its own rate window, `429` pause and in-flight requests, separate from a TypeSafe account's.
Its defaults are conservative guesses, not measurements: 60 requests a minute and 2 in flight.
Each ask is retried once, not twice, and a `429` without `Retry-After` pauses the gateway's callers for five seconds.
A `429` the gate cannot avoid still fails the ask after that pause and retry.

Gateway answers are now cached under exact model IDs and expire after 30 days, as TypeSafe's do.
Cache files from the old floating route are not reused.

## Using Jev through OpenRouter with zero data retention

Choose `DECISION_GATE_PROVIDER=openrouter` (or `"provider": "openrouter"` in config) and supply `OPENROUTER_API_KEY`.
The fixed destination is `https://openrouter.ai/api/v1/systemone`, the [documented TypeSafe SDK surface](https://openrouter.ai/docs/guides/community/typesafe-sdk), not chat completions.
The gate sends `typesafe/jev-1.13` by default or `typesafe/jev-1.14` for a 1.14 request, always requiring response provider `TypeSafe`.
A 1.13 response must name `typesafe/jev-1.13` or `typesafe/jev-1.13-20260917`; a 1.14 response must name `typesafe/jev-1.14` or `typesafe/jev-1.14-20261014`.
It validates Noul, Choice, Score and preview Box answers against the requested question names and types, plus their criteria or coordinate bounds.
The [1.13 endpoint catalog](https://openrouter.ai/api/v1/models/typesafe/jev-1.13/endpoints), [1.14 endpoint catalog](https://openrouter.ai/api/v1/models/typesafe/jev-1.14/endpoints) and ZDR catalog list both versions, checked 2026-10-16.
The general OpenRouter model list omits these evaluation models; it is not evidence that a version is unavailable.

Every OpenRouter attempt, including retries, forces these provider preferences:

```json
{ "zdr": true, "data_collection": "deny", "allow_fallbacks": false, "only": ["typesafe"] }
```

A request carrying its own `provider` field is refused before anything is sent, whatever it holds; the gate adds the preferences above itself.
Only `model`, `state`, `questions` and preview Box `assets` are accepted as top-level request fields; metadata, plugins, logging, fallback models and other passthrough fields are refused.
Questions accept only `type`, `instructions` and `criteria`.

Immediately before each paid attempt, after rate/spend waits, the gate fetches the public [ZDR endpoint catalog](https://openrouter.ai/api/v1/endpoints/zdr) without credentials or local caching.
It requires exactly one TypeSafe endpoint for the requested model, named `TypeSafe | typesafe/jev-1.13-20260917` or `TypeSafe | typesafe/jev-1.14-20261014` as appropriate, with the expected provider tag, price and advertised capacity.
It refuses missing, changed, ambiguous, unreadable or unavailable eligibility, redirects, undated responses and catalogs older than 60 seconds by HTTP Date or Age; at most five seconds of future server clock skew is accepted.
A retry cannot reuse a previous attempt's catalog check.
After the check, the attempt is confirmed against the account's pause and rate window at the moment it is sent; if another caller recorded a pause meanwhile, it waits that out and checks the catalog again.
If the check goes stale during that confirmation, such as while waiting for another process's lock on the shared limiter state, the catalog is fetched once more and the attempt is refused if it goes stale again.
These are eligibility and routing checks, not an independent ZDR receipt from the service.
[OpenRouter's ZDR policy](https://openrouter.ai/docs/guides/features/zdr) documents per-request `provider.zdr` and notes that OpenRouter itself does not retain prompts unless prompt logging is opted into.
Do not opt into account-level prompt logging when using this route; request fields cannot undo an account opt-in.

The default never-send policy still blocks email, even on OpenRouter.
Every OpenRouter run, default or ZDR-scoped, also refuses anything shaped like an OpenRouter key (`sk-or-v1-…`, in any case), not only the configured one.
To allow customer contact values unchanged, opt into one run, not a global redaction switch:

```js
const run = jev.run({ customerValues: "zdr" });
try {
  const result = await run.ask({
    state: { name: "Example Person", email: "example@example.test" },
    questions: { mentioned: { type: "noul", instructions: "Was an email provided?" } }
  });
} finally {
  await run.close();
}
```

`customerValues: "zdr"` is refused for every other provider.
Inside that run, the built-in email prohibition is omitted; credential checks (including OpenRouter-format keys and the route's actual key) and custom forbidden patterns remain enforced.
Names, addresses and ordinary phone numbers are not universally blocked by the built-in policy in the first place.
The public `jev.redactor` remains the default never-send redactor; do not pre-redact contact values intended for the explicitly scoped run.
A later default run on the same client still refuses email.

OpenRouter has its own key files, spend ledger, rate window and pauses, never another provider's key or fallback.
Use `"openrouter": { "key_file": "~/.config/decision-gate/openrouter-key" }` for its config key file, or `key: { provider: "openrouter", value }` for a private in-memory credential.
Its conservative rate defaults are 60 requests/minute, 250,000 tokens/second and 2 in flight; these are not measured OpenRouter account limits.
Its catalog now advertises 262,144-token long-context capacity for both versions.
The gate still enforces its conservative 64,000 whole-request and 32,000 state-plus-question estimates and never sends the long-context header.
Spend remains conservatively reserved at the existing 65,536-token bound and booked at USD 0.042 per million reported input tokens, output free, not from caller metadata or an arbitrary response cost.
`DECISION_GATE_ENDPOINT` overrides are refused for OpenRouter, including loopback; use injected `fetch` for offline tests.
No credential or inference call is needed to run the tests.

## Opening the gate

`openJev({ tool, model, key, neverSend, spend, maxRetries, env, notice, fetch })` opens a caller.
`model` selects the exact default version for this caller's asks and caches, with 1.13 as the default.
`tool` is required: a short identifier such as `herdr-find` that tags the caller's spend records, not a different service.
`notice` receives one-line warnings and the answering model for each validated response; it defaults to a no-op.
`spend` accepts `perRunUsd` and `perDayUsd`, defaulting to the config's USD 0.02 and USD 0.20.
The config's daily ceiling covers the key across every tool that uses it; a caller's `perDayUsd` can only lower what that tool spends, never add to the key's.
Each run defaults to `customerValues: "never-send"`; only OpenRouter permits the explicit `customerValues: "zdr"` run scope described above.
`maxRetries` is how many times a failed request is retried, 2 by default, or 1 through the gateway.
`fetch` replaces the network for tests; the destination is still checked.

The returned object holds `status()`, `config`, `redactor`, `remaining()`, `cache()` and `run()`.
`remaining()` resolves to what is left of today's ceiling for this tool on this key.

## Key sources

Every key belongs to one provider and is only ever sent to that provider.
Key precedence is an explicit key for the selected provider, then that provider's key variable (`TYPESAFE_API_KEY`, `AI_GATEWAY_API_KEY` or `OPENROUTER_API_KEY`), then that provider's key file.
An explicit key names its provider and exactly one source: `key: { provider: "typesafe", file }`, `{ provider, env }` or `{ provider, value }`.
An explicit key for another provider is skipped, never sent.
TypeSafe's key file is the config's top-level `key_file`; the gateway's is `key_file` in a `"vercel-ai-gateway"` section, such as `"vercel-ai-gateway": { "key_file": "~/.config/decision-gate/gateway-key" }`, and that section holds nothing else.
No other credential location is guessed, and no provider falls back to another's key.
Key files must be regular, nonempty files with mode 600.
`jev.status()` returns `{ ok: true }` or `{ ok: false, reason }` without reading the contents of a key file; `missing: true` marks the case where the selected provider has no key source at all, and then `label` and `keyEnv` name the provider and its key variable.
A status check cannot establish whether the service will accept a credential.
The key is read when a request or remaining-budget lookup first needs its fingerprint, and it is never enumerable, logged or stored.

## Configuration

The one config file is `$XDG_CONFIG_HOME/decision-gate/config.json`, normally `~/.config/decision-gate/config.json`.
`DECISION_GATE_CONFIG` overrides that location.
No file is required.

```json
{
  "provider": "typesafe",
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

`provider` is `typesafe` (the default), `vercel-ai-gateway` or `openrouter`; anything else is refused.
`DECISION_GATE_PROVIDER`, `DECISION_GATE_PER_RUN_USD`, `DECISION_GATE_PER_DAY_USD`, `DECISION_GATE_RPM`, `DECISION_GATE_TPS`, `DECISION_GATE_IN_FLIGHT` and `DECISION_GATE_NEVER_SEND_FILE` override the corresponding config values.
Relative paths in the file resolve beside it, and `~/` works.
Every tool reads the same limits and daily ceiling; an explicit caller per-run ceiling remains the caller's own.

## Accounts and rate limits

TypeSafe counts rate limits per account, not per key.
A second key on the same account adds no capacity: measured on one account, small requests got about 47,000-56,000 tokens a second on one key and 46,000 combined on two, and large ones about 121,000 on one and 127,000 split across two.
A key per tool is for separate spend records and revocation, not for throughput.

A key does not reveal its account, so the gate assumes every TypeSafe key on this machine belongs to one account.
Every TypeSafe key shares that account's one rate window, one 429 pause and one set of in-flight requests, across every tool and process on the machine.

`limits` describes the account's ceiling:

- `requests_per_minute` and `tokens_per_second` are TypeSafe's published limits for the pinned model; the gate keeps to `share` of both.
- `in_flight` is how many requests the account may have open at once, 4 by default.

Those defaults are TypeSafe's, and the unsectioned keys apply to the `typesafe` provider only.
The gateway keeps its own defaults, 60 requests a minute and 2 in flight, whatever the unsectioned keys say.
A section named after a provider, such as `"limits": { "vercel-ai-gateway": { "in_flight": 1 } }`, applies only to that provider and wins over its defaults and, for `typesafe`, over the unsectioned keys; the `DECISION_GATE_*` variables win over all of them.

Only one large request, estimated at 32,000 tokens or more, is open at a time; that is fixed, not configured.

TypeSafe's `in_flight` default is measured: requests of about 6,100 tokens finished fastest with two to four in flight, and requests of about 50,000 tokens finished as fast one at a time as two or four at once.
A tool that sends requests in parallel should size its pool from `jev.config.limits.inFlight` instead of keeping its own setting, since the gate holds any extra requests until a slot frees.

## Runs

```js
const run = jev.run({ capUsd });
await run.ask(request, { signal, previewBox: false });
run.summary();
await run.close();
```

`capUsd` can lower the per-run ceiling, never raise it.
A request's `model` may be omitted to use the caller's version, or be an exact ID from `ALLOWED_MODELS`.
The gate maps it to the provider's versioned wire ID and refuses versions unavailable on that route.
Raw requests are checked, not silently rewritten: a forbidden value in any serialized field or its decoded JSON form prevents the request.
Callers that send user text redact it first with `jev.redactor.redact`, and `jev.redactor.check(body)` runs the same final check on a serialized request before anything is queued.
`jev.redactor.clean(text)` is true when one piece of text would pass that check as a string in a request: nothing forbidden survives in it and the built-in rules would leave it unchanged.
A caller batching many texts into one request can use it on each redacted text to hold back only the ones the check would refuse, instead of losing the whole request.
Built-in rules cover known secret formats, email addresses and authorization credentials in the two shapes above, not arbitrary long hashes or random-looking strings elsewhere, so file paths reach the service unchanged.
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
A request too long for the pinned model is refused with a `RequestSizeError` before anything is queued or sent.
The model's context length has two budgets: 65,536 tokens for the whole request (`MAX_INPUT_TOKENS`), and 32,768 tokens for the `state` plus the single longest question (`MAX_STATE_QUESTION_TOKENS`).
Both are checked with the same estimate of a quarter token per serialized byte that `estimateUsd` uses, so a state of about 100,000 ASCII characters with short questions fits.
The estimate is not exact, so a request close to either budget can still be rejected by the service.
Use `describeError` for a safe diagnostic instead of logging a transport exception or provider response body.
The errors it passes through are `ConfigError`, `ServiceError` (with the HTTP `status`), `SpendCapError`, `RedactionError`, `RequestSizeError` and `StateError`; none carries request text.

`PINNED_MODEL`, `MAX_INPUT_TOKENS`, `MAX_STATE_QUESTION_TOKENS`, `usdFor(tokens)` and `estimateUsd(bytes)` describe the pinned model's request limits and price, which the gate also books for the gateway and OpenRouter.
`jev.config.provider`, `jev.config.model`, `jev.config.modelVersion` and `jev.config.pinned` report the provider, default wire ID, canonical version and pin status.
An ask's explicit model override is reflected in its response and notice, not by mutating the caller's config.
`estimateUsd` uses the measured rate of about a quarter token per byte, for figures shown before a run; it is not a reservation.

## Answer cache

```js
const cache = jev.cache({ scope: { prompt: "line-v1", query }, model: "jev-1.14.0", enabled: true });
cache.get(key); // a probability, or undefined
await cache.put([[key, 0.93]]);
```

The cache stores probabilities under caller-supplied string keys, and never the keys themselves.
Each key is stored as an HMAC under a private random key, so short keys such as source lines cannot be guessed from the stored hashes.
Entries are filed by the caller's `scope` together with the provider, model, endpoint and never-send list, so changing any of them starts a fresh file.
The cache's `model` defaults to the version selected in `openJev`; name it explicitly when caching an ask that overrides the caller's version.
Entries hold only key hashes, probabilities and times.
They expire after 30 days; a file mostly made of expired or superseded rows is rewritten on its next write, and files are evicted to keep the cache within 50 MiB.
A cache that cannot be read or written warns once through `notice` and continues without caching, not without spend accounting.

## Request ownership and persisted state

The official `@typesafe-ai/sdk` owns serialization, timeouts, retries and Retry-After parsing.
The gate explicitly sets its key, destination, model and logging level, so SDK environment defaults cannot redirect or log requests.
Before the SDK starts a request's first attempt, the gate waits for room under the run's ceiling and for one of the account's in-flight slots, so a queued request never uses up its attempt's 30-second timeout.
The slot is held until the request settles, across the SDK's retries.
Its fetch wrapper checks the exact body, reserves the attempt against the run's ceiling, counts it in the account's rate window and persists the reservation before every network attempt, including retries.
A refusal known not to be billed, such as a 429, hands its reservation to the retry, so the retry needs no new room.
A retry after an attempt that may have been billed reserves afresh without waiting; if it does not fit, that request fails as a service error, and only booked plus held spend reaching the ceiling stops a run at its ceiling.
Each attempt is confirmed against the account's pause and window again at the moment it is sent, and restamped then, so a pause another caller recorded after admission still holds it back.
A retry that waits out the rate window past its timeout is a timeout the SDK may retry.
Redirects are never followed.
A 429 or 529 records a pause for the whole account using the server's Retry-After delay, or a short fallback when absent, before SDK retry handling continues.
Each provider has one hard-coded destination, and no configuration can add another.
For TypeSafe and Vercel tests only, `DECISION_GATE_ENDPOINT` may point at an HTTP URL on `127.0.0.1` or `::1`; any other host is refused.
OpenRouter refuses all endpoint overrides.

State lives under `$XDG_STATE_HOME/decision-gate`, normally `~/.local/state/decision-gate`, and the cache under `$XDG_CACHE_HOME/decision-gate/answers`:

| Path | Holds |
| --- | --- |
| `cache-key` | The answer cache's private hash key |
| `spend/typesafe/<key-fingerprint>.jsonl` | The cost ledger: tool, time, hold and cost of each run, never text |
| `limits/typesafe/accounts/default.json` | The account's shared rate window, pause and in-flight requests |
| `spend/vercel-ai-gateway/<key-fingerprint>.jsonl` | The same ledger for gateway keys |
| `limits/vercel-ai-gateway/accounts/default.json` | The gateway's own rate window, pause and in-flight requests |
| `spend/openrouter/<key-fingerprint>.jsonl` | The same ledger for OpenRouter keys |
| `limits/openrouter/accounts/default.json` | OpenRouter's own rate window, pause and in-flight requests |

The fingerprint is the first 16 SHA-256 hex characters, never the key.
Rate requests use a rolling minute window; tokens use a rolling second window, counting each request at its size in bytes, up to the request limit.
Measured usage is about a quarter token per byte, so this overcounts; the spend ceiling, not the limiter, is the guaranteed bound.
The TypeSafe defaults enforce 960 requests a minute and 200,000 reserved tokens a second.
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
Successful responses replace the reservation with reported input usage.
An uncertain attempt remains booked at its reservation.
This can refuse a very small allowance even when a displayed estimate is lower.

## Providers and dependency review

Native TypeSafe, experimental Vercel AI Gateway and pinned ZDR-enforced OpenRouter are implemented; all speak TypeSafe's API through the same SDK responder.
OpenRouter extends that owner with request-policy, catalog-eligibility and typed-response validation hooks.
The public OpenRouter [SDK surface](https://openrouter.ai/docs/guides/community/typesafe-sdk), [routing fields](https://openrouter.ai/docs/guides/routing/provider-selection), [ZDR policy and catalog](https://openrouter.ai/docs/guides/features/zdr) and versioned endpoint catalogs inform this route.
The versioned catalogs and current capacity were checked again on 2026-10-16.
A provider keeps its name, key variable, exact version-to-wire-ID mapping and pin status, price, endpoint, limit defaults and retry settings together, and its state is filed under its name, so adding one needs no migration.
Another provider needs a known price, where zero counts for a local model, and comparable typed probabilities before it can support these ceilings and callers' thresholds.

The pinned `@typesafe-ai/sdk` version is 0.6.0, with no runtime dependencies or install hooks.
Its published ESM entry point was inspected for credentials, logging, HTTP destinations, retries and filesystem or execution side effects.
SDK logging is explicitly off because debug logging can include request bodies.
Version selection and preview Box reuse this responder; SDK 0.6.0 passes JSON assets and Box questions through without a dependency change.
All local state and key-file access belong to decision-gate.
