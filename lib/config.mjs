import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ConfigError } from "./errors.mjs";
import { DEFAULT_PROVIDER, providers } from "./providers/index.mjs";

const NAME = "decision-gate";
export const expandHome = (value) => value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;

export function amount(value, name, { positive = false } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || (positive ? value <= 0 : value < 0)) throw new ConfigError(`${name} must be a ${positive ? "positive" : "nonnegative"} number`);
  return value;
}

export function loadConfig(env = process.env) {
  const file = env.DECISION_GATE_CONFIG || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), NAME, "config.json");
  let user = {};
  try { user = JSON.parse(readFileSync(file, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT" || env.DECISION_GATE_CONFIG) throw new ConfigError("cannot read config as JSON");
  }
  const object = (value) => value && typeof value === "object" && !Array.isArray(value);
  if (!object(user) || (user.spend !== undefined && !object(user.spend)) || (user.limits !== undefined && !object(user.limits))) throw new ConfigError("config, spend and limits must be objects");
  // The provider is only ever chosen by name, never from whichever key variable happens to be set,
  // since other tools export those keys for their own use
  const provider = env.DECISION_GATE_PROVIDER ?? user.provider ?? DEFAULT_PROVIDER;
  if (!Object.hasOwn(providers, provider)) throw new ConfigError(`provider must be one of ${Object.keys(providers).join(", ")}`);
  const nested = Object.entries(user.limits ?? {}).filter(([, value]) => object(value));
  if (nested.some(([name]) => !Object.hasOwn(providers, name))) throw new ConfigError("limits may nest only a known provider's own limits");
  // Unsectioned limits describe a TypeSafe account, so another provider keeps its own defaults
  // unless its own section overrides them
  const shared = Object.fromEntries(Object.entries(user.limits ?? {}).filter(([, value]) => !object(value)));
  const limits = { ...(provider === DEFAULT_PROVIDER ? shared : {}), ...user.limits?.[provider] };
  // A key belongs to one provider: the top-level key_file is TypeSafe's, and any other provider's
  // lives in a section named after it
  const own = Object.keys(providers).filter((name) => name !== DEFAULT_PROVIDER && user[name] !== undefined);
  if (own.some((name) => !object(user[name]) || Object.keys(user[name]).some((field) => field !== "key_file"))) throw new ConfigError("a provider's config section holds only its key_file");
  const keyFile = provider === DEFAULT_PROVIDER ? user.key_file : user[provider]?.key_file;
  const defaults = providers[provider].limits;
  const number = (name, fallback, label, positive = false) => amount(env[name] !== undefined ? (env[name].trim() ? Number(env[name]) : NaN) : fallback, label, { positive });
  const location = (value, fromEnv, label) => {
    if (value === null) return null;
    if (typeof value !== "string" || !value.trim()) throw new ConfigError(`${label} must be a path`);
    return path.resolve(fromEnv ? process.cwd() : path.dirname(file), expandHome(value));
  };
  const share = amount(limits.share ?? 0.8, "limits.share", { positive: true });
  if (share > 1) throw new ConfigError("limits.share must not exceed 1");
  const whole = (value, label) => {
    if (!Number.isInteger(value)) throw new ConfigError(`${label} must be a positive whole number`);
    return value;
  };
  return {
    provider,
    key_file: location(keyFile ?? null, false, "key_file"),
    never_send_file: location(env.DECISION_GATE_NEVER_SEND_FILE || user.never_send_file || null, !!env.DECISION_GATE_NEVER_SEND_FILE, "never_send_file"),
    spend: {
      perRunUsd: number("DECISION_GATE_PER_RUN_USD", user.spend?.per_run_usd ?? 0.02, "per-run ceiling"),
      perDayUsd: number("DECISION_GATE_PER_DAY_USD", user.spend?.per_day_usd ?? 0.2, "daily ceiling")
    },
    limits: {
      requestsPerMinute: number("DECISION_GATE_RPM", limits.requests_per_minute ?? defaults.requestsPerMinute, "requests per minute", true),
      tokensPerSecond: number("DECISION_GATE_TPS", limits.tokens_per_second ?? defaults.tokensPerSecond, "tokens per second", true),
      share,
      // Measured on one account: requests of about 6,100 tokens finished fastest at two to four in
      // flight, while at about 50,000 tokens one at a time was as fast as two or four
      inFlight: whole(number("DECISION_GATE_IN_FLIGHT", limits.in_flight ?? defaults.inFlight, "limits.in_flight", true), "limits.in_flight"),
      largeInFlight: 1,
      largeRequestTokens: 32000
    },
    stateDir: location(path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), NAME), true, "state directory"),
    cacheDir: location(path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), NAME, "answers"), true, "cache directory")
  };
}

function privateFile(file) {
  const stat = statSync(file);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new ConfigError("key file must be a private regular file (chmod 600)");
  if (!stat.size) throw new ConfigError("key file must contain one nonempty line");
}

// A caller's key names the provider it belongs to, and is used only when that provider is selected,
// so a key never goes to another provider's endpoint
export function keySource(explicit, config, env, provider) {
  const kinds = explicit && typeof explicit === "object" ? Object.keys(explicit).filter((name) => name !== "provider") : [];
  if (explicit != null && (!Object.hasOwn(providers, explicit.provider) || kinds.length !== 1 || !["file", "env", "value"].includes(kinds[0]) || typeof explicit[kinds[0]] !== "string")) throw new ConfigError("key needs its provider and exactly one file, env or value source");
  const own = explicit?.provider === provider.name ? { [kinds[0]]: explicit[kinds[0]] } : null;
  const source = own ?? (env[provider.keyEnv]?.trim() ? { env: provider.keyEnv } : config.key_file ? { file: config.key_file } : null);
  const where = provider.name === DEFAULT_PROVIDER ? "key_file" : `key_file in the config's ${provider.name} section`;
  const status = () => {
    try {
      if (!source) return { ok: false, missing: true, label: provider.label, keyEnv: provider.keyEnv, reason: `a ${provider.label} API key is needed: export ${provider.keyEnv} or set ${where}; nothing was sent` };
      if (source.file !== undefined) privateFile(expandHome(source.file));
      else if (!(source.value ?? env[source.env])?.trim()) throw new ConfigError("configured key source is empty");
      return { ok: true };
    } catch (error) { return { ok: false, reason: error instanceof ConfigError ? error.message : "cannot read the configured key file" }; }
  };
  return Object.freeze({
    status,
    read() {
      const state = status();
      if (!state.ok) throw new ConfigError(state.reason);
      let value;
      try { value = (source.file !== undefined ? readFileSync(expandHome(source.file), "utf8") : source.value ?? env[source.env]).trim(); }
      catch { throw new ConfigError("cannot read the configured key source"); }
      if (!value || /[\s\x00-\x1f\x7f]/.test(value)) throw new ConfigError("configured key must contain one nonempty token");
      return Object.freeze(Object.defineProperties({}, {
        authorization: { value: `Bearer ${value}` },
        fingerprint: { value: createHash("sha256").update(value).digest("hex").slice(0, 16), enumerable: true }
      }));
    }
  });
}
