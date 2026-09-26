import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openJev, PINNED_MODEL, MAX_INPUT_TOKENS, usdFor } from "../lib/index.mjs";

const request = (text) => ({ model: PINNED_MODEL, state: { text }, questions: { q: { type: "noul", instructions: "Is the text about keys?" } } });
const files = (dir) => readdirSync(dir).filter((name) => /\.jsonl?$/.test(name));

function stateDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "decision-gate-keys-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Keys are ledgered separately even on one account, while their rate window is the account's
test("two keys at once book spend to separate ledgers under the per-key daily ceiling", async (t) => {
  const dir = stateDir(t);
  const keys = { a: "fixture-key-a", b: "fixture-key-b" };
  for (const [name, value] of Object.entries(keys)) writeFileSync(path.join(dir, name), `${value}\n`, { mode: 0o600 });
  // Key a's answer bills most of a reservation, so its second request no longer fits today
  const billed = { [`Bearer ${keys.a}`]: 60000, [`Bearer ${keys.b}`]: 100 };
  const seen = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    seen.push(req.headers.authorization);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: PINNED_MODEL, answers: { q: { type: "noul", noul: 0.7 } }, usage: { input_tokens: billed[req.headers.authorization] } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const perDay = 1.5 * usdFor(MAX_INPUT_TOKENS);
  const env = {
    XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, XDG_CACHE_HOME: dir,
    DECISION_GATE_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1/systemone`,
    DECISION_GATE_PER_DAY_USD: String(perDay)
  };
  const open = (name, tool = "fixture") => openJev({ env, tool, key: { file: path.join(dir, name) }, maxRetries: 0 });
  const a = open("a", "jevzf").run(), b = open("b", "herdr-find").run();
  await Promise.all([a.ask(request("first on a")), b.ask(request("first on b"))]);
  const [refused, second] = await Promise.allSettled([a.ask(request("second on a")), b.ask(request("second on b"))]);
  await Promise.all([a.close(), b.close()]);
  // Key a's own spend fills its ceiling; key b's allowance is untouched by it
  assert.match(refused.reason?.message, /spend cap reached/);
  assert.equal(second.value.answers.q.noul, 0.7);
  assert.deepEqual(seen.sort(), [`Bearer ${keys.a}`, `Bearer ${keys.b}`, `Bearer ${keys.b}`]);
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} is not ${expected}`);
  near(await open("a").remaining(), perDay - usdFor(60000));
  near(await open("b").remaining(), perDay - 2 * usdFor(100));
  const ledgers = path.join(dir, "decision-gate/spend/typesafe");
  const rows = files(ledgers).map((name) => readFileSync(path.join(ledgers, name), "utf8").trim().split("\n").map((line) => JSON.parse(line)));
  assert.deepEqual(rows.map((ledger) => [...new Set(ledger.map((row) => row.tool))]).sort(), [["herdr-find"], ["jevzf"]]);
  for (const name of files(ledgers)) {
    const stored = readFileSync(path.join(ledgers, name), "utf8");
    for (const value of Object.values(keys)) assert.ok(!name.includes(value) && !stored.includes(value));
  }
});

// A loopback stand-in for TypeSafe that can refuse the next request, and can hold each answer
// until `hold.open` requests are open at once or `hold.ms` passes, so the peak it records is the
// most the gate let through rather than an accident of timing
async function standIn(t, { hold } = {}) {
  const seen = [];
  let refuseNext = false, open = 0, peak = 0;
  const server = createServer(async (req, res) => {
    open++; peak = Math.max(peak, open);
    for await (const _ of req);
    seen.push(req.headers.authorization);
    for (const start = Date.now(); hold && open < hold.open && Date.now() - start < hold.ms;) await new Promise((resolve) => setTimeout(resolve, 5));
    open--;
    if (refuseNext) {
      refuseNext = false;
      res.writeHead(429, { "retry-after-ms": "5000" });
      return res.end("{}");
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: PINNED_MODEL, answers: { q: { type: "noul", noul: 0.6 } }, usage: { input_tokens: 100 } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return { seen, url: `http://127.0.0.1:${server.address().port}/v1/systemone`, refuseNext: () => { refuseNext = true; }, peak: () => peak };
}

// Two fake keys, a and b, on the one account every key shares
async function twoKeys(t, { limits = {}, hold, time } = {}) {
  const dir = stateDir(t);
  const server = await standIn(t, { hold });
  for (const name of ["a", "b"]) writeFileSync(path.join(dir, name), `fixture-key-${name}\n`, { mode: 0o600 });
  const config = path.join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ limits: { share: 1, ...limits } }));
  const env = { XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, XDG_CACHE_HOME: dir, DECISION_GATE_CONFIG: config, DECISION_GATE_ENDPOINT: server.url };
  const open = (name) => openJev({ env, time, tool: "fixture", key: { file: path.join(dir, name) }, maxRetries: 0 });
  const jevs = { a: open("a"), b: open("b") };
  const runs = { a: jevs.a.run(), b: jevs.b.run() };
  t.after(() => Promise.all([runs.a.close(), runs.b.close()]));
  return { dir, server, jevs, ask: (name, text = `public ${name}`) => runs[name].ask(request(text)) };
}

function fakeTime() {
  let now = Date.UTC(2026, 8, 26, 12);
  const waits = [];
  return { waits, time: { now: () => now, sleep: async (ms) => { waits.push(ms); now += ms; } } };
}

test("two keys on one account share one rate window and one 429 pause", async (t) => {
  const window = fakeTime();
  const w = await twoKeys(t, { limits: { requests_per_minute: 2 }, time: window.time });
  await w.ask("a");
  await w.ask("b");
  // A third request in the minute waits, since both keys used the account's two starts
  await w.ask("b");
  assert.deepEqual(window.waits, [60000]);

  const pause = fakeTime();
  const p = await twoKeys(t, { time: pause.time });
  p.server.refuseNext();
  await assert.rejects(p.ask("a"), (error) => error.status === 429);
  await p.ask("b");
  assert.deepEqual(pause.waits, [5000]);
  await p.ask("a");
  assert.deepEqual(pause.waits, [5000]);
  assert.deepEqual(p.server.seen, [`Bearer fixture-key-a`, `Bearer fixture-key-b`, `Bearer fixture-key-a`]);

  // The account's one window names nothing about either key
  const limits = path.join(p.dir, "decision-gate/limits/typesafe");
  assert.deepEqual(readdirSync(limits), ["accounts"]);
  assert.deepEqual(files(path.join(limits, "accounts")), ["default.json"]);
  const stored = readFileSync(path.join(limits, "accounts/default.json"), "utf8");
  assert.ok(!stored.includes("fixture-key") && !/[0-9a-f]{16}/.test(stored.replace(/"token":"[^"]*"/g, "")), stored);
});

test("an account keeps four small requests in flight across its keys, and large ones one at a time", async (t) => {
  const w = await twoKeys(t, { hold: { open: 5, ms: 300 } });
  await Promise.all(Array.from({ length: 8 }, (_, i) => w.ask(i % 2 ? "a" : "b")));
  assert.equal(w.server.peak(), 4);
  assert.equal(w.jevs.a.config.limits.inFlight, 4);
  const narrow = await twoKeys(t, { hold: { open: 3, ms: 300 }, limits: { in_flight: 2 } });
  await Promise.all(Array.from({ length: 6 }, (_, i) => narrow.ask(i % 2 ? "a" : "b")));
  assert.equal(narrow.server.peak(), 2);
  // About 32,500 tokens each at the measured quarter token per byte
  const large = await twoKeys(t, { hold: { open: 2, ms: 300 } });
  const text = "public words ".repeat(10000);
  await Promise.all(["a", "b", "a"].map((name) => large.ask(name, text)));
  assert.equal(large.server.peak(), 1);
});

test("in_flight is a positive whole number from the config or DECISION_GATE_IN_FLIGHT", (t) => {
  const dir = stateDir(t);
  const config = path.join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ limits: { in_flight: 3 } }));
  const env = { XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, XDG_CACHE_HOME: dir, DECISION_GATE_CONFIG: config, TYPESAFE_API_KEY: "fixture-only" };
  assert.equal(openJev({ env, tool: "fixture" }).config.limits.inFlight, 3);
  assert.equal(openJev({ env: { ...env, DECISION_GATE_IN_FLIGHT: "6" }, tool: "fixture" }).config.limits.inFlight, 6);
  writeFileSync(config, JSON.stringify({ limits: { in_flight: 1.5 } }));
  assert.throws(() => openJev({ env, tool: "fixture" }), /in_flight must be a positive whole number/);
});
