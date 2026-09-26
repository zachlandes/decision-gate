import path from "node:path";
import { StateError } from "./errors.mjs";
import { clock, locked, readJson, writeJson } from "./state.mjs";

const localWindows = new Map();

export function createLimiter({ dir, fingerprint, limits, notice = () => {}, time = clock }) {
  const file = path.join(dir, `${fingerprint}.json`);
  const rpm = Math.floor(limits.requestsPerMinute * limits.share);
  const tps = Math.floor(limits.tokensPerSecond * limits.share);
  let local = false;
  const transaction = async (job, signal) => {
    if (!local) {
      try {
        return await locked(file, () => {
          const state = readJson(file, { starts: [], pausedUntil: 0 });
          if (!Array.isArray(state.starts) || !Number.isFinite(state.pausedUntil) || state.starts.some((e) => !Number.isFinite(e.at) || !Number.isFinite(e.tokens) || e.tokens < 0)) throw new StateError("invalid rate-limit state");
          const result = job(state);
          writeJson(file, state);
          return result;
        }, { signal, time });
      } catch (error) {
        if (!["EACCES", "EPERM", "EROFS", "ENOSPC", "ENOTDIR"].includes(error.code)) throw error;
        local = true;
        notice("shared rate-limit state is unwritable; using in-process limits (spend ceilings still apply)");
      }
    }
    if (!localWindows.has(file)) localWindows.set(file, { starts: [], pausedUntil: 0 });
    return job(localWindows.get(file));
  };
  return {
    async take(tokens, signal) {
      if (rpm < 1 || tokens > tps) throw new StateError("configured rate limits cannot fit one reserved request; increase DECISION_GATE_RPM or DECISION_GATE_TPS");
      for (;;) {
        signal?.throwIfAborted();
        const wait = await transaction((state) => {
          const now = time.now();
          state.starts = state.starts.filter((e) => e.at > now - 60000);
          if (state.pausedUntil > now) return state.pausedUntil - now;
          let until = now;
          if (state.starts.length >= rpm) until = Math.max(until, state.starts[state.starts.length - rpm].at + 60000);
          const recent = state.starts.filter((e) => e.at > now - 1000);
          let total = recent.reduce((sum, e) => sum + e.tokens, tokens);
          for (const entry of recent) {
            if (total <= tps) break;
            total -= entry.tokens;
            until = Math.max(until, entry.at + 1000);
          }
          if (until > now) return until - now;
          state.starts.push({ at: now, tokens });
          return 0;
        }, signal);
        if (!wait) return;
        await time.sleep(wait, signal);
      }
    },
    async pause(ms) {
      await transaction((state) => { state.pausedUntil = Math.max(state.pausedUntil, time.now() + ms); });
    }
  };
}
