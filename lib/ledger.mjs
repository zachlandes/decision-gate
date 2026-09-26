import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { SpendCapError, StateError } from "./errors.mjs";
import { appendRecord, clock, locked, replaceFile } from "./state.mjs";

const HOLD_MS = 10 * 60000;
const day = (now) => new Date(now).toISOString().slice(0, 10);

function records(file, now) {
  let text;
  try { text = readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return new Map(); throw error; }
  const latest = new Map();
  const lines = text.split("\n").filter(Boolean);
  try {
    for (const line of lines) {
      const row = JSON.parse(line);
      if (typeof row.id !== "string" || typeof row.tool !== "string" || typeof row.day !== "string" || !Number.isFinite(row.at) || !Number.isFinite(row.usd) || row.usd < 0 || !Number.isFinite(row.hold) || row.hold < row.usd || typeof row.closed !== "boolean") throw new Error();
      latest.set(row.id, row);
    }
  } catch { throw new StateError("invalid spend ledger; refusing to spend"); }
  // Only today's rows count and only yesterday's runs may still close, so compact the rest away
  // rather than re-reading every past run under the lock
  const live = new Set([day(now), day(now - 86400000)]);
  const kept = [...latest.values()].filter((row) => live.has(row.day));
  if (lines.length - kept.length > Math.max(256, kept.length)) {
    replaceFile(file, kept.map((row) => `${JSON.stringify(row)}\n`).join(""));
    return new Map(kept.map((row) => [row.id, row]));
  }
  return latest;
}

function used(rows, today, now, except, tool) {
  return [...rows.values()].filter((r) => (tool === undefined || r.tool === tool) && r.day === today && r.id !== except).reduce((sum, r) => sum + (!r.closed && now - r.at < HOLD_MS ? r.hold : r.usd), 0);
}

// The key's ceiling counts every tool on the key; a tool's own ceiling can only lower it
export function createLedger({ dir, fingerprint, tool, perDayUsd, toolPerDayUsd = Infinity, time = clock }) {
  const file = path.join(dir, `${fingerprint}.jsonl`);
  const available = (rows, today, now, except) => Math.min(perDayUsd - used(rows, today, now, except), toolPerDayUsd - used(rows, today, now, except, tool));
  return {
    remaining() {
      return locked(file, () => {
        const now = time.now();
        return Math.max(0, available(records(file, now), day(now), now));
      }, { time });
    },
    async open(capUsd, signal) {
      let row;
      await locked(file, () => {
        const now = time.now();
        row = { id: randomUUID(), tool, day: day(now), at: now, usd: 0, hold: Math.min(capUsd, Math.max(0, available(records(file, now), day(now), now))), closed: false };
        appendRecord(file, row);
      }, { signal, time });
      const update = (total, closed = false) => locked(file, () => {
        const usd = typeof total === "function" ? total() : total;
        const now = time.now();
        const rows = records(file, now);
        if (row.closed) throw new StateError("run is closed");
        // A renewed lease or midnight boundary must re-check other processes' holds
        if (!closed && (day(now) !== row.day || now - row.at >= HOLD_MS)) {
          if (day(now) !== row.day) throw new SpendCapError("UTC day changed; start a new run");
          row.hold = Math.min(row.hold, Math.max(row.usd, available(rows, row.day, now, row.id)));
        }
        if (!closed && usd > row.hold + 1e-12) throw new SpendCapError("daily spend ceiling reached");
        row = { ...row, at: now, usd, hold: closed ? usd : Math.max(usd, row.hold), closed };
        appendRecord(file, row);
      }, { time });
      return { capUsd: row.hold, book: (usd) => update(usd), close: (usd) => update(usd, true) };
    }
  };
}
