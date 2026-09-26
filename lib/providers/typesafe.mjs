// Adapted from herdr-find 4736dd5 (Apache-2.0)
import { APIError, RateLimitError, TypeSafeClient } from "@typesafe-ai/sdk";
import { usdAt } from "../budget.mjs";
import { RequestSizeError, ServiceError, SpendCapError } from "../errors.mjs";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const PINNED_MODEL = "jev-1.13.0";
// Output tokens are free for this model
export const JEV_PRICE = {
  model: PINNED_MODEL,
  usd_per_million_input_tokens: 0.042,
  source: "https://docs.typesafe.ai/models.md",
  checked: "2026-09-25"
};

// The documented context length has two budgets: the whole request, and the state plus its
// longest question, since the state is read once and each question is judged against it. Spend
// reserves the whole-request budget, not an empirical bytes/token ratio
export const MAX_INPUT_TOKENS = 65536;
export const MAX_STATE_QUESTION_TOKENS = 32768;
// For estimates shown before a run, the measured rate rather than the reservation
export const ESTIMATE_TOKENS_PER_BYTE = 0.25;

export const usdFor = (tokens) => usdAt(JEV_PRICE, tokens);

export const estimateUsd = (bytes) => usdFor(bytes * ESTIMATE_TOKENS_PER_BYTE);

const estimatedTokens = (value) => Buffer.byteLength(JSON.stringify(value) ?? "") * ESTIMATE_TOKENS_PER_BYTE;

// Refuses a request the model would reject for its length, by the same measured estimate shown
// before a run, so it fails here without being sent. The estimate is not exact, so a request close
// to either budget can still be rejected by the service
function checkSize(request) {
  const questions = Object.values(request?.questions ?? {});
  if (estimatedTokens(request) > MAX_INPUT_TOKENS) {
    throw new RequestSizeError(`request is estimated above the model's ${MAX_INPUT_TOKENS}-token limit; nothing was sent`);
  }
  const longest = Math.max(0, ...questions.map(estimatedTokens));
  if (estimatedTokens(request?.state) + longest > MAX_STATE_QUESTION_TOKENS) {
    throw new RequestSizeError(`state plus its longest question is estimated above the model's ${MAX_STATE_QUESTION_TOKENS}-token limit; nothing was sent`);
  }
}

// Only a loopback address may stand in for TypeSafe, so a test's stand-in can never be a real host
// the key would be sent to
function endpoint(env = process.env) {
  const wanted = env.DECISION_GATE_ENDPOINT;
  if (!wanted) return JEV_ENDPOINT;
  try {
    const url = new URL(wanted);
    if (url.protocol === "http:" && !url.username && !url.password && ["127.0.0.1", "[::1]"].includes(url.hostname)) return url.href;
  } catch { /* Report a generic error without echoing the supplied URL */ }
  throw new ServiceError("DECISION_GATE_ENDPOINT must be a numeric HTTP loopback URL");
}

function createResponder({ key, budget, assertSafe, limiter, book = async () => {}, fetchImpl = globalThis.fetch, endpoint = JEV_ENDPOINT, timeoutMs = 30000, maxRetries = 2 }) {
  if (!key?.authorization || !budget || !assertSafe) throw new TypeError("key, spend budget and never-send check are required");
  return async (request, { signal } = {}) => {
    if (request.model !== PINNED_MODEL) throw new ServiceError("request model is not pinned");
    const abort = new AbortController();
    let localError;
    const local = async (fn) => {
      try { return await fn(); }
      catch (error) { localError = error; abort.abort(); throw error; }
    };
    // Usage measures about a quarter token per request byte, so counting bytes overcounts
    // without throttling like the full-context spend reservation would
    const counted = (bytes) => Math.min(bytes, MAX_INPUT_TOKENS);
    let first, slot, sent = false;
    const client = new TypeSafeClient({
      apiKey: key.authorization.slice("Bearer ".length),
      baseURL: new URL(endpoint).origin,
      defaultModel: PINNED_MODEL,
      // Explicit settings prevent SDK environment defaults from leaking data or keys
      logLevel: "off",
      timeout: timeoutMs,
      retry: { maxRetries, respectRetryAfter: true },
      fetch: async (_url, init) => {
        await local(() => assertSafe(init.body));
        if (sent) {
          // A retry's wait for the account's window runs inside its timer, so an abort there is
          // left to the SDK as a retryable timeout, not a local failure that ends the ask
          try { await slot?.again(counted(Buffer.byteLength(init.body)), { signal: init.signal }); }
          catch (error) { if (init.signal.aborted) throw error; await local(() => { throw error; }); }
        }
        sent = true;
        let ticket = first;
        first = undefined;
        // A retry after an attempt that may have been billed cannot wait for spend inside its
        // timer, so one that does not fit now fails this request rather than the ceiling
        if (!ticket) {
          ticket = await local(async () => {
            let held;
            try { held = budget.reserve(MAX_INPUT_TOKENS); }
            catch (error) { throw error instanceof SpendCapError ? new ServiceError("TypeSafe request failed and its retry does not fit under the spend ceiling now") : error; }
            try { await book(); } catch (error) { held.release(); throw error; }
            return held;
          });
        }
        let response;
        try {
          // Surface redirects as non-retryable HTTP errors without following them
          response = await fetchImpl(endpoint, { ...init, redirect: "manual" });
        } catch (error) {
          await local(async () => { ticket.settle(null); await book(); });
          throw error;
        }
        await local(async () => {
          if (!response.ok) {
            if (response.status >= 500 || response.status === 408) ticket.settle(null);
            // An unbilled refusal keeps its reservation for the retry, so the retry needs no new room
            else first = ticket;
          } else {
            let json;
            try { json = await response.clone().json(); }
            catch { /* An unreadable response may still have been billed */ }
            const tokens = json?.usage?.input_tokens;
            ticket.settle(Number.isInteger(tokens) && tokens <= MAX_INPUT_TOKENS ? tokens : null);
          }
          await book();
          // The slot is held until the whole call settles, so no waiter starts ahead of this pause
          if (response.status === 429 || response.status === 529) {
            const delay = new RateLimitError(response.status, undefined, response.headers).retryAfterMs;
            await limiter?.pause(Number.isFinite(delay) ? delay : 1000);
          }
        });
        return response;
      }
    });
    const bytes = Buffer.byteLength(JSON.stringify(request));
    // The first attempt's reservation and the account slot are taken before the SDK starts its
    // attempt timer, so waiting for either never uses up or aborts the attempt
    first = await budget.acquire(MAX_INPUT_TOKENS, signal);
    try {
      slot = await limiter?.take(counted(bytes), { estimated: bytes * ESTIMATE_TOKENS_PER_BYTE, signal });
      await book();
    } catch (error) { first.release(); await slot?.release(); throw error; }
    let json;
    try {
      json = await client.systemOne(request, { signal: signal ? AbortSignal.any([signal, abort.signal]) : abort.signal });
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (localError) throw localError;
      if (error instanceof APIError) {
        if (error.status === 429 || error.status === 529) {
          // The SDK exposes its Retry-After parser through RateLimitError, including HTTP dates
          const delay = new RateLimitError(error.status, undefined, error.headers).retryAfterMs;
          const after = Number.isFinite(delay) ? `${Math.ceil(delay / 1000)} seconds` : "not supplied";
          throw new ServiceError(`TypeSafe returned HTTP ${error.status}; stopped; retry-after: ${after}`, { status: error.status });
        }
        throw new ServiceError(`TypeSafe returned HTTP ${error.status}`, { status: error.status });
      }
      throw new ServiceError("TypeSafe request failed; no input or key logged");
    } finally {
      await slot?.release();
      // A reservation no attempt used holds no spend
      if (first) { first.release(); await book(); }
    }
    if (json?.model !== PINNED_MODEL) throw new ServiceError("TypeSafe answered with an unexpected model");
    return json;
  };
}

export const typesafe = Object.freeze({
  name: "typesafe",
  label: "TypeSafe",
  keyEnv: "TYPESAFE_API_KEY",
  model: PINNED_MODEL,
  price: JEV_PRICE,
  endpoint,
  checkSize,
  respond: createResponder
});
