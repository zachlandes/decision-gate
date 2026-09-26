// Spend accounting adapted from herdr-find 4736dd5 (Apache-2.0)
import { SpendCapError } from "./errors.mjs";

export const usdAt = (price, tokens) => (tokens * price.usd_per_million_input_tokens) / 1e6;

// A spend cap enforced before every send: an attempt reserves its worst case first and is refused
// if the reservation would pass the cap. A response books its billed tokens; an attempt that may
// have reached the service without a usable answer books its reservation, since it may be billed.
export function createSpendBudget({ capUsd, price, spentUsd = 0, onChange = () => {} }) {
  if (!(Number.isFinite(capUsd) && capUsd >= 0)) throw new TypeError("a nonnegative spend cap in USD is required");
  let booked = spentUsd;
  let reserved = 0;
  let open = 0;
  let billedTokens = 0;
  let unknownAttempts = 0;
  let waiters = [];
  const wake = () => { for (const resolve of waiters) resolve(); waiters = []; };
  const reserve = (tokens) => {
    const usd = usdAt(price, tokens);
    if (booked + reserved + usd > capUsd) throw new SpendCapError("spend cap reached");
    reserved += usd;
    open += 1;
    onChange(booked + reserved);
    let active = true;
    const finish = () => { active = false; reserved -= usd; open -= 1; };
    return {
      settle(billed) {
        if (!active) return;
        finish();
        if (Number.isInteger(billed) && billed >= 0) {
          booked += usdAt(price, billed);
          billedTokens += billed;
        } else {
          booked += usd;
          unknownAttempts += 1;
        }
        onChange(booked + reserved);
        wake();
      },
      release() {
        if (!active) return;
        finish();
        onChange(booked + reserved);
        wake();
      }
    };
  };
  return {
    capUsd,
    reserve,
    // Attempts in flight usually settle far below their worst case, so a full cap waits for one
    // of them before refusing; with nothing in flight the refusal is final
    async acquire(tokens, signal) {
      for (;;) {
        signal?.throwIfAborted();
        try { return reserve(tokens); }
        catch (error) { if (!(error instanceof SpendCapError) || !open) throw error; }
        await new Promise((resolve, reject) => {
          const abort = () => reject(signal.reason);
          signal?.addEventListener("abort", abort, { once: true });
          waiters.push(() => { signal?.removeEventListener("abort", abort); resolve(); });
        });
      }
    },
    // What is committed so far, counting requests still in flight at their reservation
    committedUsd: () => booked + reserved,
    summary() {
      return { cap_usd: capUsd, committed_usd: booked + reserved, billed_input_tokens: billedTokens, attempts_booked_at_reservation: unknownAttempts };
    }
  };
}
