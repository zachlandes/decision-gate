import path from "node:path";
import { amount, loadConfig, keySource } from "./config.mjs";
import { createSpendBudget } from "./budget.mjs";
import { TTL, answerCache } from "./cache.mjs";
import { ConfigError, RedactionError, RequestSizeError, ServiceError, SpendCapError, StateError } from "./errors.mjs";
import { createLedger } from "./ledger.mjs";
import { createLimiter } from "./limits.mjs";
import { providers } from "./providers/index.mjs";
import { createRedactor, loadRedactor } from "./redaction.mjs";
import { clock } from "./state.mjs";

export { ConfigError, RedactionError, RequestSizeError, ServiceError, SpendCapError, StateError };
export { privateKeyLines } from "./redaction.mjs";
export { PINNED_MODEL, MAX_INPUT_TOKENS, MAX_STATE_QUESTION_TOKENS, usdFor, estimateUsd } from "./providers/typesafe.mjs";

export function openJev(options = {}) {
  const { env = process.env, notice = () => {}, time = clock, tool } = options;
  if (typeof tool !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(tool)) throw new ConfigError("tool must be a short identifier");
  const config = loadConfig(env);
  const provider = providers[config.provider];
  const toolPerDayUsd = options.spend?.perDayUsd === undefined ? Infinity : amount(options.spend.perDayUsd, "daily ceiling");
  const spend = {
    perRunUsd: amount(options.spend?.perRunUsd ?? config.spend.perRunUsd, "per-run ceiling"),
    perDayUsd: Math.min(toolPerDayUsd, config.spend.perDayUsd)
  };
  const source = keySource(options.key, config, env, provider);
  const neverSend = options.neverSend ?? config.never_send_file;
  const redactor = Object.freeze(neverSend ? loadRedactor(neverSend) : createRedactor());
  const endpoint = provider.endpoint(env);
  const limiter = createLimiter({ dir: path.join(config.stateDir, "limits", provider.name), limits: config.limits, notice, time });
  let identity;
  const credentials = () => {
    if (!identity) {
      const key = source.read();
      identity = {
        key,
        ledger: createLedger({ dir: path.join(config.stateDir, "spend", provider.name), fingerprint: key.fingerprint, tool, perDayUsd: config.spend.perDayUsd, toolPerDayUsd, time })
      };
    }
    return identity;
  };
  const jev = Object.freeze({
    status: source.status,
    config: Object.freeze({ ...config, spend, provider: provider.name, model: provider.model, pinned: provider.pinned, endpoint }),
    redactor,
    notice,
    time,
    remaining: () => credentials().ledger.remaining(),
    // Answers are filed per provider, model, endpoint and never-send list as well as the caller's
    // scope, so a change to any of them starts a fresh file instead of reusing stale answers
    // A floating model can change behind its id, so its answers expire within a day
    cache({ scope, enabled = true, notice: warn = notice } = {}) {
      return answerCache({
        ttl: provider.pinned ? TTL : 86400000,
        stateDir: config.stateDir,
        cacheDir: config.cacheDir,
        scope: { provider: provider.name, model: provider.model, endpoint, neverSend: redactor.fingerprint, caller: scope ?? null },
        enabled,
        notice: warn,
        time
      });
    },
    run({ capUsd = spend.perRunUsd } = {}) {
      amount(capUsd, "run ceiling");
      const budgetCap = Math.min(capUsd, spend.perRunUsd);
      let budget, lease, responder, ready, closing;
      const pending = new Set();
      const initialize = () => ready ??= (async () => {
        const { key, ledger } = credentials();
        lease = await ledger.open(budgetCap);
        budget = createSpendBudget({ capUsd: lease.capUsd, price: provider.price });
        // The ledger reads the committed total inside its lock, so concurrent attempts never
        // persist an older total over a newer one
        const book = () => lease.book(() => budget.committedUsd());
        responder = provider.respond({ key, budget, limiter, book, assertSafe: (body) => redactor.check(body), endpoint, fetchImpl: options.fetch, maxRetries: options.maxRetries, timeoutMs: options.timeoutMs });
      })().catch((error) => { ready = undefined; throw error; });
      return Object.freeze({
        ask(request, { signal } = {}) {
          if (closing) return Promise.reject(new StateError("run is closed"));
          // Own the serialized snapshot before async work can observe caller mutations
          let snapshot;
          try {
            snapshot = JSON.stringify(request);
            redactor.check(snapshot);
            provider.checkSize(JSON.parse(snapshot));
          } catch (error) { return Promise.reject(error); }
          const job = (async () => {
            signal?.throwIfAborted();
            await initialize();
            return responder(JSON.parse(snapshot), { signal });
          })();
          pending.add(job);
          job.then(() => pending.delete(job), () => pending.delete(job));
          return job;
        },
        // Which ceiling bounds this run: its own, or what is left of today's once the run has opened
        summary: () => ({ ...(budget?.summary() ?? { cap_usd: budgetCap, committed_usd: 0, billed_input_tokens: 0, attempts_booked_at_reservation: 0 }), ceiling: lease && lease.capUsd < budgetCap ? "day" : "run" }),
        close() {
          // Closing waits for asks already made, so the ledger records their final cost
          closing ??= (async () => {
            await Promise.allSettled([...pending]);
            if (lease) await lease.close(budget.committedUsd());
          })();
          return closing;
        }
      });
    }
  });
  return jev;
}

export function describeError(error) {
  const safe = [ConfigError, ServiceError, SpendCapError, RedactionError, RequestSizeError, StateError].some((Type) => error instanceof Type);
  return safe ? error.message.replace(/[\r\x1b]/g, " ") : "request failed; check file access and network connectivity (no input or key logged)";
}
