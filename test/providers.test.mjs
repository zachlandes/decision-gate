import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openJev, PINNED_MODEL, usdFor } from "../lib/index.mjs";

const GATEWAY = "https://ai-gateway.vercel.sh/typesafe/v1/systemone";
const TYPESAFE = "https://api.typesafe.ai/v1/systemone";
const request = (text, model) => ({ ...(model === undefined ? {} : { model }), state: { text }, questions: { q: { type: "noul", instructions: "Is the text useful?" } } });

function setup(t, { config, env: extra = {}, answer } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "decision-gate-providers-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, XDG_CACHE_HOME: dir, TYPESAFE_API_KEY: "fixture-typesafe", AI_GATEWAY_API_KEY: "fixture-gateway", ...extra };
  if (config) {
    env.DECISION_GATE_CONFIG = path.join(dir, "config.json");
    writeFileSync(env.DECISION_GATE_CONFIG, JSON.stringify(config));
  }
  const sent = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url, authorization: init.headers.Authorization ?? init.headers.authorization, body });
    if (answer) return answer(body, sent.length);
    return new Response(JSON.stringify({ model: body.model, answers: { q: { type: "noul", noul: 0.7 } }, usage: { input_tokens: 275, output_tokens: 0 }, provider_metadata: { gateway: { cost: "0.5" } } }));
  };
  const open = (options = {}) => openJev({ env, fetch, tool: "fixture", ...options });
  return { dir, env, sent, open };
}

async function ask(jev, body) {
  const run = jev.run();
  try { return await run.ask(body); }
  finally { await run.close(); }
}

test("the provider is TypeSafe unless named, even when only a gateway key is set", async (t) => {
  const f = setup(t, { env: { TYPESAFE_API_KEY: "" } });
  const jev = f.open();
  assert.equal(jev.config.provider, "typesafe");
  assert.equal(jev.status().ok, false);
  assert.match(jev.status().reason, /TYPESAFE_API_KEY/);
  assert.throws(() => setup(t, { env: { DECISION_GATE_PROVIDER: "vercel" } }).open(), /provider must be one of typesafe, vercel-ai-gateway/);
  assert.throws(() => setup(t, { config: { provider: "__proto__" } }).open(), /provider must be one of/);
  assert.throws(() => setup(t, { config: { limits: { typo: { in_flight: 1 } } } }).open(), /known provider/);
});

test("each provider sends only its own key, only to its own endpoint", async (t) => {
  for (const [how, extra, config] of [["config", {}, { provider: "vercel-ai-gateway" }], ["environment", { DECISION_GATE_PROVIDER: "vercel-ai-gateway" }, { provider: "typesafe" }]]) {
    const f = setup(t, { env: extra, config });
    await ask(f.open(), request("public"));
    assert.deepEqual(f.sent.map(({ url, authorization }) => [url, authorization]), [[GATEWAY, "Bearer fixture-gateway"]], how);
  }
  const f = setup(t);
  await ask(f.open(), request("public"));
  assert.deepEqual(f.sent.map(({ url, authorization }) => [url, authorization]), [[TYPESAFE, "Bearer fixture-typesafe"]]);
});

test("a key goes only to the provider it belongs to, with no fallback to another's", async (t) => {
  const write = (dir, name, text) => { writeFileSync(path.join(dir, name), text, { mode: 0o600 }); return path.join(dir, name); };
  // TypeSafe's key_file, key variable and a caller's TypeSafe key never reach the gateway
  const gateway = setup(t, { config: { provider: "vercel-ai-gateway", key_file: "typesafe-key" }, env: { AI_GATEWAY_API_KEY: "" } });
  write(gateway.dir, "typesafe-key", "file-typesafe\n");
  const typesafeKey = { provider: "typesafe", file: write(gateway.dir, "caller-typesafe-key", "caller-typesafe\n") };
  for (const key of [undefined, typesafeKey]) {
    const jev = gateway.open({ key });
    assert.deepEqual([jev.status().missing, jev.status().keyEnv], [true, "AI_GATEWAY_API_KEY"]);
    assert.match(jev.status().reason, /^a Vercel AI Gateway API key is needed: export AI_GATEWAY_API_KEY or set key_file in the config's vercel-ai-gateway section; nothing was sent$/);
    await assert.rejects(ask(jev, request("public")), /Vercel AI Gateway API key is needed/);
  }
  assert.equal(gateway.sent.length, 0);

  // The gateway's own key file sits in its section, and a caller's gateway key wins over it
  const sectioned = setup(t, { config: { provider: "vercel-ai-gateway", key_file: "typesafe-key", "vercel-ai-gateway": { key_file: "gateway-key" } }, env: { AI_GATEWAY_API_KEY: "" } });
  write(sectioned.dir, "typesafe-key", "file-typesafe\n");
  write(sectioned.dir, "gateway-key", "file-gateway\n");
  await ask(sectioned.open(), request("public"));
  await ask(sectioned.open({ key: typesafeKey }), request("public"));
  await ask(sectioned.open({ key: { provider: "vercel-ai-gateway", value: "caller-gateway" } }), request("public"));
  assert.deepEqual(sectioned.sent.map(({ url, authorization }) => [url, authorization]), [[GATEWAY, "Bearer file-gateway"], [GATEWAY, "Bearer file-gateway"], [GATEWAY, "Bearer caller-gateway"]]);

  // The reverse: the gateway's key file, key variable and a caller's gateway key never reach TypeSafe
  const native = setup(t, { config: { "vercel-ai-gateway": { key_file: "gateway-key" } }, env: { TYPESAFE_API_KEY: "" } });
  write(native.dir, "gateway-key", "file-gateway\n");
  for (const key of [undefined, { provider: "vercel-ai-gateway", value: "caller-gateway" }]) {
    const jev = native.open({ key });
    assert.match(jev.status().reason, /^a TypeSafe API key is needed: export TYPESAFE_API_KEY or set key_file; nothing was sent$/);
    await assert.rejects(ask(jev, request("public")), /TypeSafe API key is needed/);
  }
  assert.equal(native.sent.length, 0);

  assert.throws(() => setup(t).open({ key: { value: "untagged" } }), /key needs its provider/);
  assert.throws(() => setup(t).open({ key: { provider: "vercel", value: "fixture" } }), /key needs its provider/);
  assert.throws(() => setup(t, { config: { "vercel-ai-gateway": { key_file: "k", in_flight: 1 } } }).open(), /holds only its key_file/);
});

test("the gate owns the wire model, and the gateway's is floating", async (t) => {
  const f = setup(t, { config: { provider: "vercel-ai-gateway" } });
  const jev = f.open();
  assert.deepEqual([jev.config.provider, jev.config.model, jev.config.pinned, jev.config.endpoint], ["vercel-ai-gateway", "typesafe-ai/jev", false, GATEWAY]);
  await ask(jev, request("omitted"));
  await ask(jev, request("pinned id", PINNED_MODEL));
  assert.deepEqual(f.sent.map(({ body }) => body.model), ["typesafe-ai/jev", "typesafe-ai/jev"]);
  await assert.rejects(ask(jev, request("other", "jev-2.0.0")), /model must be omitted or jev-1.13.0/);
  await assert.rejects(ask(jev, request("wire id", "typesafe-ai/jev")), /model must be omitted or jev-1.13.0/);
  assert.equal(f.sent.length, 2);

  const native = setup(t);
  const pinned = native.open();
  assert.deepEqual([pinned.config.model, pinned.config.pinned], [PINNED_MODEL, true]);
  await ask(pinned, request("omitted"));
  await assert.rejects(ask(pinned, request("floating", "typesafe-ai/jev")), /model must be omitted/);
  assert.deepEqual(native.sent.map(({ body }) => body.model), [PINNED_MODEL]);
  assert.equal(native.sent.length, 1);
});

test("a gateway answer from another model is refused with the gateway named", async (t) => {
  const f = setup(t, { config: { provider: "vercel-ai-gateway" }, answer: () => new Response(JSON.stringify({ model: PINNED_MODEL, answers: {}, usage: { input_tokens: 100 } })) });
  await assert.rejects(ask(f.open(), request("public")), /^ServiceError: Vercel AI Gateway answered with an unexpected model$/);
});

test("gateway usage is booked at the listed price, ignoring its metadata, in its own ledger", async (t) => {
  const f = setup(t, { config: { provider: "vercel-ai-gateway" } });
  const run = f.open().run();
  await run.ask(request("public"));
  await run.close();
  assert.equal(run.summary().committed_usd, usdFor(275));
  const ledgers = path.join(f.dir, "decision-gate/spend");
  assert.deepEqual(readdirSync(ledgers), ["vercel-ai-gateway"]);
  const stored = readdirSync(path.join(ledgers, "vercel-ai-gateway")).map((name) => readFileSync(path.join(ledgers, "vercel-ai-gateway", name), "utf8")).join("");
  assert.ok(!stored.includes("fixture-gateway"));
});

test("a gateway 429 without Retry-After pauses only the gateway's account, and errors name the gateway", async (t) => {
  let now = Date.UTC(2026, 8, 26, 12);
  const time = { now: () => now, sleep: async (ms) => { now += ms; } };
  const f = setup(t, { config: { provider: "vercel-ai-gateway" }, answer: (_body, n) => n === 1 ? new Response("{}", { status: 429 }) : new Response("{}", { status: 402 }) });
  const jev = f.open({ time, maxRetries: 0 });
  await assert.rejects(ask(jev, request("shed")), (error) => error.status === 429 && /^Vercel AI Gateway returned HTTP 429; stopped; retry-after: not supplied$/.test(error.message));
  const limits = path.join(f.dir, "decision-gate/limits");
  assert.deepEqual(readdirSync(limits), ["vercel-ai-gateway"]);
  const { pausedUntil } = JSON.parse(readFileSync(path.join(limits, "vercel-ai-gateway/accounts/default.json"), "utf8"));
  assert.equal(pausedUntil - now, 5000);
  // A 402 reaches callers as a ServiceError carrying its status
  await assert.rejects(ask(jev, request("unpaid")), (error) => error.status === 402 && error.message === "Vercel AI Gateway returned HTTP 402");
  assert.equal(f.sent.length, 2);
});

test("the gateway retries once by default", async (t) => {
  const f = setup(t, { config: { provider: "vercel-ai-gateway" }, answer: () => new Response("{}", { status: 503, headers: { "retry-after-ms": "1" } }) });
  await assert.rejects(ask(f.open(), request("down")), (error) => error.status === 503);
  assert.equal(f.sent.length, 2);
});

test("the never-send check refuses before any gateway attempt", async (t) => {
  const f = setup(t, { config: { provider: "vercel-ai-gateway" } });
  await assert.rejects(ask(f.open(), request("Bearer abcdefghijklmnopqrst")), /never-send/);
  assert.equal(f.sent.length, 0);
});

test("limits default per provider, unsectioned limits are TypeSafe's, and a provider's own section overrides them", (t) => {
  const limits = (config, env) => setup(t, { config, env }).open().config.limits;
  const pick = ({ requestsPerMinute, tokensPerSecond, inFlight, share }) => ({ requestsPerMinute, tokensPerSecond, inFlight, share });
  assert.deepEqual(pick(limits()), { requestsPerMinute: 1200, tokensPerSecond: 250000, inFlight: 4, share: 0.8 });
  assert.deepEqual(pick(limits({ provider: "vercel-ai-gateway" })), { requestsPerMinute: 60, tokensPerSecond: 250000, inFlight: 2, share: 0.8 });
  const shared = { requests_per_minute: 1200, tokens_per_second: 250000, share: 0.5, in_flight: 4 };
  assert.deepEqual(pick(limits({ provider: "vercel-ai-gateway", limits: shared })), { requestsPerMinute: 60, tokensPerSecond: 250000, inFlight: 2, share: 0.8 });
  assert.deepEqual(pick(limits({ limits: { ...shared, requests_per_minute: 600 } })), { requestsPerMinute: 600, tokensPerSecond: 250000, inFlight: 4, share: 0.5 });
  const config = { provider: "vercel-ai-gateway", limits: { requests_per_minute: 30, in_flight: 3, "vercel-ai-gateway": { in_flight: 1, share: 1 }, typesafe: { in_flight: 8 } } };
  assert.deepEqual(pick(limits(config)), { requestsPerMinute: 60, tokensPerSecond: 250000, inFlight: 1, share: 1 });
  assert.equal(limits(config, { DECISION_GATE_IN_FLIGHT: "2" }).inFlight, 2);
  assert.deepEqual(pick(limits({ ...config, provider: "typesafe" })), { requestsPerMinute: 30, tokensPerSecond: 250000, inFlight: 8, share: 0.8 });
});

test("the gateway provider's endpoint takes only a loopback stand-in", async (t) => {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push([req.url, req.headers.authorization, JSON.parse(body).model]);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: "typesafe-ai/jev", answers: { q: { type: "noul", noul: 0.6 } }, usage: { input_tokens: 100 } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const f = setup(t, { env: { DECISION_GATE_PROVIDER: "vercel-ai-gateway", DECISION_GATE_ENDPOINT: `http://127.0.0.1:${server.address().port}/typesafe/v1/systemone` } });
  const jev = openJev({ env: f.env, tool: "fixture" });
  assert.equal((await ask(jev, request("public"))).answers.q.noul, 0.6);
  assert.deepEqual(seen, [["/typesafe/v1/systemone", "Bearer fixture-gateway", "typesafe-ai/jev"]]);
  assert.throws(() => openJev({ env: { ...f.env, DECISION_GATE_ENDPOINT: "https://ai-gateway.vercel.sh.example/typesafe/v1/systemone" }, tool: "fixture" }), /numeric HTTP loopback URL/);
});

test("answers cached through the unpinned gateway expire within a day", async (t) => {
  const hour = 3600000;
  let now = Date.UTC(2026, 8, 26, 12);
  const time = { now: () => now, sleep: async () => {} };
  const scope = { query: "fixture" };
  const cached = async (config) => {
    const jev = setup(t, { config }).open({ time });
    now = Date.UTC(2026, 8, 26, 12);
    await jev.cache({ scope }).put([["item", 0.4]]);
    return (hours) => { now = Date.UTC(2026, 8, 26, 12) + hours * hour; return jev.cache({ scope }).get("item"); };
  };
  const gateway = await cached({ provider: "vercel-ai-gateway" });
  assert.deepEqual([gateway(23), gateway(25)], [0.4, undefined]);
  const pinned = await cached(undefined);
  assert.deepEqual([pinned(25), pinned(29 * 24), pinned(31 * 24)], [0.4, 0.4, undefined]);
});
