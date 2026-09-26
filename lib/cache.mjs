import { closeSync, fsyncSync, linkSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { appendRecords, clock, locked, privateDir, replaceFile } from "./state.mjs";

const TTL = 30 * 86400000;
const MAX_BYTES = 50 * 1024 * 1024;

function hashKey(stateDir) {
  privateDir(stateDir);
  const file = path.join(stateDir, "cache-key");
  try {
    const key = readFileSync(file);
    if (key.length !== 32 || (statSync(file).mode & 0o777) !== 0o600) throw new Error("invalid cache key");
    return key;
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const temp = `${file}.${randomUUID()}`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, randomBytes(32)); fsyncSync(fd); }
  finally { closeSync(fd); }
  try { linkSync(temp, file); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  finally { rmSync(temp, { force: true }); }
  return hashKey(stateDir);
}

function liveRows(text, now) {
  const rows = new Map();
  let lines = 0;
  for (const line of text.split("\n")) {
    if (!line) continue;
    lines++;
    try {
      const row = JSON.parse(line);
      if (/^[a-f0-9]{64}$/.test(row.h) && Number.isFinite(row.p) && row.p >= 0 && row.p <= 1 && Number.isFinite(row.t) && row.t <= now && row.t > now - TTL) rows.set(row.h, row);
    } catch { /* A partial or corrupt entry is a miss, never an answer */ }
  }
  return { rows, stale: lines - rows.size };
}

export function answerCache({ stateDir, cacheDir, scope, enabled = true, notice = () => {}, time = clock }) {
  let key, file;
  const warn = () => { notice("answer cache unavailable; continuing without caching"); enabled = false; };
  const hash = (value) => createHmac("sha256", key).update(value).digest("hex");
  if (enabled) {
    try {
      key = hashKey(stateDir);
      privateDir(cacheDir);
      file = path.join(cacheDir, `${hash(JSON.stringify(scope))}.jsonl`);
    } catch { warn(); }
  }
  let entries = new Map(), stale = 0;
  if (enabled) {
    try { ({ rows: entries, stale } = liveRows(readFileSync(file, "utf8"), time.now())); }
    catch (error) { if (error.code !== "ENOENT") warn(); }
  }
  return {
    get(name) { return enabled ? entries.get(hash(name))?.p : undefined; },
    // One locked write per batch of [key, probability] pairs
    async put(pairs) {
      // Only a key's keyed hash and a number are stored, so nothing else is accepted
      if (!Array.isArray(pairs) || pairs.some((pair) => typeof pair?.[0] !== "string" || !Number.isFinite(pair[1]) || pair[1] < 0 || pair[1] > 1)) throw new TypeError("cache entries must be [string key, probability] pairs");
      if (!enabled || !pairs.length) return;
      try {
        const now = time.now();
        const rows = pairs.map(([name, p]) => ({ h: hash(name), p, t: now }));
        await locked(path.join(cacheDir, "maintenance"), () => {
          // Expired and superseded rows would otherwise keep a busy query's file growing forever
          if (stale > Math.max(256, entries.size)) {
            let text = "";
            try { text = readFileSync(file, "utf8"); }
            catch (error) { if (error.code !== "ENOENT") throw error; }
            const current = liveRows(text, now).rows;
            replaceFile(file, [...current.values()].map((row) => `${JSON.stringify(row)}\n`).join(""));
            entries = current;
            stale = 0;
          }
          let total = 0;
          const files = readdirSync(cacheDir).filter((name) => /^[a-f0-9]{64}\.jsonl$/.test(name)).map((name) => {
            const full = path.join(cacheDir, name), stat = statSync(full);
            total += stat.size;
            return { full, stat };
          }).sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs);
          const bytes = rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)) + 1, 0);
          for (const entry of files) {
            if (total + bytes <= MAX_BYTES && entry.stat.mtimeMs > now - TTL) continue;
            rmSync(entry.full); total -= entry.stat.size;
          }
          appendRecords(file, rows);
        }, { time });
        for (const row of rows) entries.set(row.h, row);
      } catch { warn(); }
    }
  };
}
