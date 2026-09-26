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

// Keys are ledgered separately even on one account; whether they should share one rate window
// belongs to the account-keyed limiter, so this test does not pin it
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
