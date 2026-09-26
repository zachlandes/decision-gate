import { closeSync, constants, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, chmodSync, statSync, appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { StateError } from "./errors.mjs";

export const clock = { now: Date.now, sleep: (ms, signal) => delay(Math.min(ms, 2147483647), undefined, { signal }) };

// Holders never keep a lock across network or sleep, so a lock this old belongs to a stopped
// process or a reused PID, never to a slow live one
const STALE_MS = 30000;

export function privateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = statSync(dir);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw new StateError("local state directory must be owned by this user");
  if ((stat.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
}

export function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new StateError("cannot read local state; refusing to spend");
  }
}

// Replaces a file atomically, so readers see the old or the new contents and never a torn write
export function replaceFile(file, text) {
  const temp = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    rmSync(temp, { force: true });
  }
}

export const writeJson = (file, value) => replaceFile(file, JSON.stringify(value));

export function appendRecords(file, values) {
  // No-follow keeps a planted symlink from redirecting private records elsewhere
  const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try { appendFileSync(fd, values.map((value) => `${JSON.stringify(value)}\n`).join("")); fsyncSync(fd); }
  finally { closeSync(fd); }
}

export const appendRecord = (file, value) => appendRecords(file, [value]);

const held = new Set();

// Only an owner on this host can be proved dead; another host's pid means nothing here. `live`
// holds the tokens this process still owns
export function dead({ host, pid, token }, live = held) {
  if (host !== os.hostname()) return false;
  // A container restart can hand a killed owner's pid to this process
  if (pid === process.pid) return !live.has(token);
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === "ESRCH"; }
}

function ownerOf(lock) {
  try {
    const owner = JSON.parse(readFileSync(path.join(lock, "owner.json"), "utf8"));
    return Number.isInteger(owner?.pid) && typeof owner?.host === "string" && /^[0-9a-f-]{36}$/.test(owner?.token) ? owner : null;
  } catch { return null; }
}

function tryAcquire(lock, token) {
  const temp = `${lock}.${token}.tmp`;
  mkdirSync(temp, { mode: 0o700 });
  try {
    writeJson(path.join(temp, "owner.json"), { host: os.hostname(), pid: process.pid, token });
    // Rename publishes the lock with its owner already inside, so a crash never leaves an ownerless lock
    renameSync(temp, lock);
    return true;
  } catch (error) {
    if (error.code === "EEXIST" || error.code === "ENOTEMPTY") return false;
    throw error;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

function sweep(lock) {
  const prefix = `${path.basename(lock)}.`;
  for (const name of readdirSync(path.dirname(lock))) {
    if (!name.startsWith(prefix) || !/\.(?:tmp|stale|done)$/.test(name)) continue;
    const full = path.join(path.dirname(lock), name);
    try { if (Date.now() - statSync(full).mtimeMs > STALE_MS) rmSync(full, { recursive: true, force: true }); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function reapIfStale(lock) {
  let stat;
  try { stat = statSync(lock); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  const owner = ownerOf(lock);
  if (!(Date.now() - stat.mtimeMs > STALE_MS || (owner && dead(owner)))) return;
  // The tombstone is named after the stale owner and kept for a while, so a second reaper that
  // read the same owner fails to move a newer lock onto it instead of stealing that lock
  const tomb = `${lock}.${owner?.token ?? Math.floor(stat.mtimeMs)}.stale`;
  try {
    renameSync(lock, tomb);
    writeFileSync(path.join(tomb, "reaped"), "");
  } catch (error) { if (!["ENOENT", "EEXIST", "ENOTEMPTY"].includes(error.code)) throw error; }
  sweep(lock);
}

function release(lock, token) {
  if (ownerOf(lock)?.token !== token) return;
  // Moving the lock away first means no other process ever sees it half-deleted
  const done = `${lock}.${token}.done`;
  try { renameSync(lock, done); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  rmSync(done, { recursive: true, force: true });
}

// Callbacks are synchronous: no network or sleeps while holding a filesystem lock
export async function locked(file, job, { signal, time = clock, timeoutMs = 10000 } = {}) {
  privateDir(path.dirname(file));
  const lock = `${file}.lock`;
  const token = randomUUID();
  const start = time.now();
  for (;;) {
    signal?.throwIfAborted();
    if (tryAcquire(lock, token)) { held.add(token); break; }
    reapIfStale(lock);
    if (time.now() - start >= timeoutMs) throw new StateError("local state lock timed out; no request was sent");
    await time.sleep(20, signal);
  }
  try {
    const result = job();
    if (result?.then) throw new StateError("state transaction must be synchronous");
    return result;
  } finally {
    held.delete(token);
    release(lock, token);
  }
}
