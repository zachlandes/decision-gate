import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, chmodSync, mkdirSync, existsSync, utimesSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { openJev, describeError, RequestSizeError, PINNED_MODEL, MAX_INPUT_TOKENS, MAX_STATE_QUESTION_TOKENS, usdFor } from "../lib/index.mjs";
import { createLimiter } from "../lib/limits.mjs";
import { createLedger } from "../lib/ledger.mjs";
import { answerCache } from "../lib/cache.mjs";
import { locked } from "../lib/state.mjs";

function setup(t, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "decision-gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, XDG_CACHE_HOME: dir, TYPESAFE_API_KEY: "fixture-only" };
  const sent = [];
  const fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    const request = sent.at(-1);
    return new Response(JSON.stringify({ model: PINNED_MODEL, answers: Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul", noul: 0.9 }])), usage: { input_tokens: 100, output_tokens: 0 } }), { headers: { "content-type": "application/json" } });
  };
  return { dir, env, sent, jev: openJev({ env, fetch, maxRetries: 0, tool: "fixture", ...options }) };
}
const request = (text) => ({ model: PINNED_MODEL, state: { text }, questions: { q: { type: "noul", instructions: "Is the text useful?" } } });

for (const status of [429, 529]) {
  test(`SDK retries HTTP ${status} through the shared limiter and accounting`, async (t) => {
    let attempts = 0;
    const f = setup(t, { maxRetries: 1, fetch: async () => {
      attempts++;
      if (attempts === 1) return new Response("private provider error", { status, headers: { "retry-after-ms": "1" } });
      return new Response(JSON.stringify({ model: PINNED_MODEL, answers: { q: { type: "noul", noul: 0.8 } }, usage: { input_tokens: 100 } }));
    } });
    const run = f.jev.run();
    assert.equal((await run.ask(request("public"))).answers.q.noul, 0.8);
    await run.close();
    assert.equal(attempts, 2);
    assert.equal(run.summary().committed_usd, usdFor(100) + (status === 529 ? usdFor(MAX_INPUT_TOKENS) : 0));
    const state = JSON.parse(readFileSync(path.join(f.dir, "decision-gate/limits/typesafe/accounts/default.json")));
    assert.equal(state.starts.length, 2);
    assert.deepEqual(state.inFlight, []);
    assert.ok(state.pausedUntil > 0);
  });
}

test("raw core asks use the SDK and never-send gate without caller redaction", async (t) => {
  const f = setup(t);
  const run = f.jev.run();
  await assert.rejects(run.ask(request("Bearer abcdefghijklmnopqrst")), /never-send/);
  assert.equal(f.sent.length, 0);
  const result = await run.ask(request("public fixture"));
  assert.equal(result.answers.q.noul, 0.9);
  await run.close();
  assert.equal(f.sent.length, 1);
  assert.equal(run.summary().committed_usd, usdFor(100));
  await assert.rejects(run.ask(request("after close")), /closed/);
});

test("shared limiter enforces rolling requests, reserved tokens and pauses using a fake clock", async (t) => {
  const f = setup(t);
  let now = 100000;
  const waits = [];
  const time = { now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } };
  const options = { dir: f.dir, limits: { requestsPerMinute: 2, tokensPerSecond: 100, share: 1, inFlight: 4, largeInFlight: 1, largeRequestTokens: 32000 }, time };
  const a = createLimiter(options), b = createLimiter(options);
  const take = async (limiter, tokens) => (await limiter.take(tokens)).release();
  await take(a, 60);
  await take(b, 60);
  assert.equal(now, 101000);
  await take(a, 60);
  assert.equal(now, 160000);
  await a.pause(7000);
  await take(b, 20);
  assert.equal(now, 167000);
  assert.deepEqual(waits, [1000, 59000, 7000]);
});

test("ledger holds reserve capacity across callers, and a stale hold retains booked cost", async (t) => {
  const f = setup(t);
  let now = Date.UTC(2026, 8, 26);
  const time = { now: () => now, sleep: async (ms) => { now += ms; } };
  const options = { dir: f.dir, fingerprint: "shared", tool: "fixture", perDayUsd: 0.02, time };
  const a = createLedger(options), b = createLedger(options);
  const first = await a.open(0.02);
  await first.book(0.001);
  assert.equal((await b.open(0.02)).capUsd, 0);
  now += 600001;
  assert.equal(await b.remaining(), 0.019);
  const second = await b.open(0.019);
  await assert.rejects(first.book(0.002), /daily spend ceiling/);
  await first.close(0.001);
  await second.close(0.002);
  assert.equal(await a.remaining(), 0.017);
});

test("two tools on one key share its daily ceiling, and a tool's own ceiling only lowers it", async (t) => {
  const reserve = usdFor(MAX_INPUT_TOKENS);
  let sent = 0;
  const fetch = async (_url, init) => { sent++; return new Response(JSON.stringify({ model: PINNED_MODEL, answers: Object.fromEntries(Object.keys(JSON.parse(init.body).questions).map((id) => [id, { type: "noul", noul: 0.9 }])), usage: { input_tokens: 100 } })); };
  const f = setup(t, { fetch });
  const env = { ...f.env, DECISION_GATE_PER_DAY_USD: String(reserve + usdFor(100)) };
  const jevzf = openJev({ env, fetch, maxRetries: 0, tool: "jevzf" });
  const herdr = openJev({ env, fetch, maxRetries: 0, tool: "herdr-find", spend: { perDayUsd: 1 } });
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} is not ${expected}`);
  assert.equal(herdr.config.spend.perDayUsd, reserve + usdFor(100));
  const first = jevzf.run();
  await first.ask(request("public one"));
  await first.close();
  near(await herdr.remaining(), reserve);
  const second = herdr.run();
  await second.ask(request("public two"));
  await second.close();
  assert.equal(sent, 2);
  near(await jevzf.remaining(), reserve - usdFor(100));
  const refused = jevzf.run();
  await assert.rejects(refused.ask(request("public three")), /spend cap reached/);
  await refused.close();
  assert.equal(sent, 2);
  const lower = openJev({ env: f.env, fetch, maxRetries: 0, tool: "lower", spend: { perDayUsd: usdFor(100) / 2 } });
  near(await lower.remaining(), usdFor(100) / 2);
});

test("a run can close its old-day ledger after midnight without spending on the new day", async (t) => {
  const f = setup(t);
  let now = Date.UTC(2026, 8, 26, 23, 59, 59);
  const time = { now: () => now, sleep: async (ms) => { now += ms; } };
  const ledger = createLedger({ dir: f.dir, fingerprint: "midnight", tool: "fixture", perDayUsd: 0.02, time });
  const run = await ledger.open(0.02);
  await run.book(0.001);
  now += 2000;
  await assert.rejects(run.book(0.002), /UTC day changed/);
  await run.close(0.001);
  assert.equal(await ledger.remaining(), 0.02);
});

test("explicit key file takes precedence over the environment and enforces mode 600", async (t) => {
  const f = setup(t);
  const file = path.join(f.dir, "key");
  writeFileSync(file, "private-file-key", { mode: 0o600 });
  let authorization;
  const jev = openJev({ env: f.env, tool: "fixture", key: { file }, maxRetries: 0, fetch: async (_url, init) => {
    authorization = init.headers.Authorization ?? init.headers.authorization;
    return new Response(JSON.stringify({ model: PINNED_MODEL, answers: { q: { type: "noul", noul: 0.5 } }, usage: { input_tokens: 100 } }));
  } });
  const run = jev.run();
  await run.ask(request("public"));
  await run.close();
  assert.equal(authorization, "Bearer private-file-key");
  chmodSync(file, 0o644);
  const unsafe = openJev({ env: f.env, tool: "fixture", key: { file } });
  assert.equal(unsafe.status().ok, false);
  const refused = unsafe.run();
  await assert.rejects(refused.ask(request("public")), /chmod 600/);
  await refused.close();
});

test("separate processes share one limiter window for the account", async (t) => {
  const f = setup(t);
  const script = `
    import { createLimiter } from ${JSON.stringify(new URL("../lib/limits.mjs", import.meta.url).href)};
    const limiter = createLimiter({ dir: process.argv[1], limits: { requestsPerMinute: 100, tokensPerSecond: 100, share: 1, inFlight: 4, largeInFlight: 1, largeRequestTokens: 32000 } });
    await (await limiter.take(60)).release();
  `;
  const child = () => new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--input-type=module", "-e", script, f.dir]);
    proc.on("error", reject);
    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`limiter child exited ${code}`)));
  });
  await Promise.all([child(), child(), child()]);
  // Each take reserves 60 of 100 tokens a second, so the shared window must space the three starts
  const { starts, inFlight } = JSON.parse(readFileSync(path.join(f.dir, "accounts/default.json"), "utf8"));
  assert.deepEqual(inFlight, []);
  const times = starts.map((start) => start.at).sort((a, b) => a - b);
  assert.equal(times.length, 3);
  assert.ok(times[1] - times[0] >= 1000, `${times}`);
  assert.ok(times[2] - times[1] >= 1000, `${times}`);
});

test("locks left by dead or stopped owners are reclaimed, and live fresh locks are respected", async (t) => {
  const f = setup(t);
  const file = path.join(f.dir, "state.json");
  const lock = `${file}.lock`;
  const plant = (pid, ageMs = 0, host = hostname()) => {
    mkdirSync(lock);
    writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ host, pid, token: crypto.randomUUID() }));
    if (ageMs) utimesSync(lock, new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
  };
  const gone = spawnSync(process.execPath, ["-e", "0"]).pid;
  plant(gone);
  // A crashed acquirer's unpublished directory must not block anyone
  mkdirSync(`${lock}.${crypto.randomUUID()}.tmp`);
  assert.equal(await locked(file, () => "dead owner"), "dead owner");
  assert.ok(!existsSync(lock));
  const sleeper = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  t.after(() => sleeper.kill());
  // A live owner holding a lock this long is stopped, since holders never wait on anything
  plant(sleeper.pid, 31000);
  assert.equal(await locked(file, () => "stopped owner"), "stopped owner");
  plant(sleeper.pid);
  let now = 0;
  const time = { now: () => now, sleep: async (ms) => { now += ms; } };
  await assert.rejects(locked(file, () => "stolen", { time, timeoutMs: 100 }), /lock timed out/);
  assert.ok(existsSync(lock));
  rmSync(lock, { recursive: true });
  // A lock naming this process's own pid that this process does not hold came from a reused pid
  plant(process.pid);
  assert.equal(await locked(file, () => "reused pid"), "reused pid");
  // Another host's pid proves nothing here, so only age can free its lock
  plant(gone, 0, `not-${hostname()}`);
  await assert.rejects(locked(file, () => "stolen", { time, timeoutMs: 100 }), /lock timed out/);
  assert.ok(existsSync(lock));
});

test("a second reaper cannot move a newer lock onto the same stale owner's tombstone", async (t) => {
  const f = setup(t);
  const file = path.join(f.dir, "state.json");
  const lock = `${file}.lock`;
  const stale = crypto.randomUUID();
  const gone = spawnSync(process.execPath, ["-e", "0"]).pid;
  const plant = (marker) => {
    mkdirSync(lock);
    writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ host: hostname(), pid: gone, token: stale }));
    if (marker) mkdirSync(path.join(lock, marker));
  };
  plant();
  await locked(file, () => {});
  assert.ok(existsSync(`${lock}.${stale}.stale`));
  // A reaper that read the old owner before the first reaper moved it now sees a newer lock
  // under that owner's name; the kept tombstone makes its move fail instead of stealing it
  plant("newer");
  let now = 0;
  const time = { now: () => now, sleep: async (ms) => { now += ms; } };
  await assert.rejects(locked(file, () => "stolen", { time, timeoutMs: 60 }), /lock timed out/);
  assert.ok(existsSync(path.join(lock, "newer")));
});

test("spend ledger compaction drops past days and superseded rows but keeps today's holds", async (t) => {
  const f = setup(t);
  const now = Date.UTC(2026, 8, 26, 12);
  const time = { now: () => now, sleep: async () => {} };
  const file = path.join(f.dir, "compact.jsonl");
  mkdirSync(path.dirname(file), { recursive: true });
  const old = Array.from({ length: 400 }, (_, i) => JSON.stringify({ id: `old${i}`, tool: "fixture", day: "2026-09-20", at: now - 6 * 86400000, usd: 0.01, hold: 0.01, closed: true }));
  const today = JSON.stringify({ id: "today", tool: "fixture", day: "2026-09-26", at: now - 1000, usd: 0.005, hold: 0.005, closed: true });
  writeFileSync(file, `${[...old, today].join("\n")}\n`, { mode: 0o600 });
  const ledger = createLedger({ dir: f.dir, fingerprint: "compact", tool: "fixture", perDayUsd: 0.02, time });
  assert.equal(await ledger.remaining(), 0.015);
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.deepEqual(lines, [today]);
});

test("answer cache rewrites a file whose rows are mostly expired", async (t) => {
  const f = setup(t);
  let now = Date.UTC(2026, 8, 26);
  const time = { now: () => now, sleep: async () => {} };
  const options = { stateDir: f.dir, cacheDir: path.join(f.dir, "answers"), scope: { query: "fixture" }, time };
  await answerCache(options).put(Array.from({ length: 300 }, (_, i) => [`line ${i}`, 0.5]));
  now += 31 * 86400000;
  const cache = answerCache(options);
  assert.equal(cache.get("line 1"), undefined);
  await cache.put([["fresh", 0.7]]);
  const [name] = readdirSync(options.cacheDir).filter((file) => file.endsWith(".jsonl"));
  assert.equal(readFileSync(path.join(options.cacheDir, name), "utf8").trim().split("\n").length, 1);
  assert.equal(answerCache(options).get("fresh"), 0.7);
});

test("the answer cache takes caller keys, stores neither them nor the key, and scopes by never-send list", async (t) => {
  const f = setup(t);
  const scope = { prompt: "fixture-v1", query: "public query" };
  const cache = f.jev.cache({ scope });
  await cache.put([["public item", 0.25], ["other item", 1]]);
  assert.equal(f.jev.cache({ scope }).get("public item"), 0.25);
  assert.equal(f.jev.cache({ scope: { ...scope, query: "changed" } }).get("public item"), undefined);
  assert.equal(f.jev.cache({ scope, enabled: false }).get("public item"), undefined);
  const rules = path.join(f.dir, "never-send.json");
  writeFileSync(rules, JSON.stringify({ rules: [], forbidden: ["(?i)private"] }), { mode: 0o600 });
  const listed = openJev({ env: f.env, tool: "fixture", neverSend: rules });
  assert.equal(listed.cache({ scope }).get("public item"), undefined);
  await assert.rejects(cache.put([["text", "not a probability"]]), /probability/);
  await assert.rejects(cache.put([[{ text: "object" }, 0.5]]), /string key/);
  const dir = path.join(f.dir, "decision-gate/answers");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".jsonl"))) {
    const stored = readFileSync(path.join(dir, file), "utf8");
    for (const text of ["public item", "other item", "public query", "fixture-v1", "fixture-only"]) assert.ok(!stored.includes(text));
  }
});

test("a tool must name itself, and the never-send check refuses before anything is sent", async (t) => {
  const f = setup(t);
  assert.throws(() => openJev({ env: f.env }), /tool must be a short identifier/);
  assert.throws(() => openJev({ env: f.env, tool: "has space" }), /tool must be a short identifier/);
  assert.throws(() => f.jev.redactor.check("{not json"), /serialize as JSON/);
  assert.throws(() => f.jev.redactor.check(JSON.stringify({ state: { "Bearer abcdefghijklmnopqrst": "value" } })), /never-send/);
  assert.equal(f.jev.redactor.check(JSON.stringify(request("public"))), undefined);
  assert.equal(f.sent.length, 0);
});

test("a request over either context budget is refused before any send, and one just under is sent", async (t) => {
  let served = 0;
  const server = createServer(async (req, res) => {
    served++;
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: PINNED_MODEL, answers: Object.fromEntries(Object.keys(JSON.parse(body).questions).map((id) => [id, { type: "noul", noul: 0.9 }])), usage: { input_tokens: 100 } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const dir = mkdtempSync(path.join(tmpdir(), "decision-gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, XDG_CACHE_HOME: dir, TYPESAFE_API_KEY: "fixture-only", DECISION_GATE_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1/systemone` };
  const jev = openJev({ env, maxRetries: 0, tool: "fixture" });
  // The gate estimates a quarter token per serialized byte
  const stateBytes = MAX_STATE_QUESTION_TOKENS * 4;
  const question = (instructions) => ({ type: "noul", instructions });
  // Pads the state so it and its one question serialize to exactly `bytes`
  const sized = (bytes) => {
    const q = question("Is the text useful?");
    const padding = bytes - Buffer.byteLength(JSON.stringify({ text: "" })) - Buffer.byteLength(JSON.stringify(q));
    return { model: PINNED_MODEL, state: { text: "a".repeat(padding) }, questions: { q } };
  };
  // Each question fits the state budget, but together they pass the whole-request budget
  const wide = { model: PINNED_MODEL, state: { text: "public" }, questions: Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`q${i}`, question("b".repeat(60000))])) };
  const run = jev.run();
  for (const [request, message] of [[sized(stateBytes + 1), /^state plus its longest question is estimated above the model's 32768-token limit; nothing was sent$/], [wide, /^request is estimated above the model's 65536-token limit; nothing was sent$/]]) {
    const error = await run.ask(request).then(() => assert.fail("an over-long request was accepted"), (e) => e);
    assert.ok(error instanceof RequestSizeError);
    assert.match(describeError(error), message);
  }
  assert.equal(served, 0);
  assert.equal((await run.ask(sized(stateBytes))).answers.q.noul, 0.9);
  await run.close();
  assert.equal(served, 1);
});

test("the gate sets the pinned wire model and refuses any other", async (t) => {
  const f = setup(t);
  const run = f.jev.run();
  const { model, ...unpinned } = request("public");
  assert.equal((await run.ask(unpinned)).answers.q.noul, 0.9);
  assert.equal(f.sent[0].model, model);
  await assert.rejects(run.ask({ ...unpinned, model: "jev-0.0.1" }), /not pinned/);
  await run.close();
  assert.equal(f.sent.length, 1);
});
