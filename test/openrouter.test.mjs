import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { openJev, PINNED_MODEL, MAX_INPUT_TOKENS, usdFor, describeError } from "../lib/index.mjs";

const ENDPOINT = "https://openrouter.ai/api/v1/systemone";
const CATALOG = "https://openrouter.ai/api/v1/endpoints/zdr";
const MODEL = "typesafe/jev-1.13";
const VERSION = "typesafe/jev-1.13-20260917";
const policy = { zdr: true, data_collection: "deny", allow_fallbacks: false, only: ["typesafe"] };
const eligible = () => ({ name: `TypeSafe | ${VERSION}`, model_id: MODEL, provider_name: "TypeSafe", tag: "typesafe", pricing: { prompt: "0.000000042", completion: "0" }, context_length: 64000, max_prompt_tokens: 32000 });
const request = (state = "public") => ({ state, questions: { q: { type: "noul", instructions: "Is this useful?" } } });
const response = (fields = {}) => new Response(JSON.stringify({ model: VERSION, provider: "TypeSafe", answers: { q: { type: "noul", noul: 0.8 } }, usage: { input_tokens: 275, output_tokens: 0, cost: 999 }, ...fields }));

function setup(t, { config = {}, extraEnv = {}, catalog, answer } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "decision-gate-openrouter-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.UTC(2026, 9, 13, 18);
  const time = { now: () => now, sleep: async (ms) => { now += ms; } };
  const env = { XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, XDG_CACHE_HOME: dir, DECISION_GATE_CONFIG: path.join(dir, "config.json"), TYPESAFE_API_KEY: "fixture-typesafe", AI_GATEWAY_API_KEY: "fixture-gateway", OPENROUTER_API_KEY: "fixture-openrouter", ...extraEnv };
  writeFileSync(env.DECISION_GATE_CONFIG, JSON.stringify({ provider: "openrouter", ...config }));
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    if (url === CATALOG) return catalog ? catalog({ now, sent, advance: (ms) => { now += ms; } }) : new Response(JSON.stringify({ data: [eligible()] }), { headers: { date: new Date(now).toUTCString() } });
    assert.equal(url, ENDPOINT);
    return answer ? answer({ body: JSON.parse(init.body), sent }) : response();
  };
  const open = (options = {}) => openJev({ tool: "fixture", env, time, fetch, maxRetries: 0, ...options });
  return { dir, env, sent, open, time };
}
async function ask(jev, body = request(), options = {}) {
  const run = jev.run(options);
  try { return await run.ask(body); }
  finally { await run.close(); }
}

// All fixtures are made up and every network boundary is replaced by injected fetch
test("OpenRouter owns its endpoint, key, pinned model and rate defaults", async (t) => {
  const f = setup(t, { config: { limits: { requests_per_minute: 999, in_flight: 9 } } });
  const jev = f.open();
  assert.deepEqual([jev.config.provider, jev.config.endpoint, jev.config.model, jev.config.pinned], ["openrouter", ENDPOINT, MODEL, true]);
  assert.deepEqual([jev.config.limits.requestsPerMinute, jev.config.limits.inFlight], [60, 2]);
  await ask(jev);
  assert.deepEqual(f.sent.map(({ url }) => url), [CATALOG, ENDPOINT]);
  assert.equal(f.sent[0].init.method, "GET");
  assert.equal(f.sent[0].init.headers.Authorization, undefined);
  assert.equal(f.sent[0].init.cache, "no-store");
  assert.equal(f.sent[0].init.redirect, "manual");
  assert.equal(f.sent[1].init.headers.Authorization, "Bearer fixture-openrouter");
  assert.equal(f.sent[1].init.redirect, "manual");
  assert.deepEqual(f.sent[1].body, { ...request(), model: MODEL, provider: policy });
  assert.deepEqual(readdirSync(path.join(f.dir, "decision-gate/spend")), ["openrouter"]);
  assert.deepEqual(readdirSync(path.join(f.dir, "decision-gate/limits")), ["openrouter"]);
  for (const destination of [ENDPOINT, "https://other.invalid", "http://127.0.0.1:1234/test"]) {
    assert.throws(() => f.open({ env: { ...f.env, DECISION_GATE_ENDPOINT: destination } }), /fixed endpoint/);
  }
});

test("OpenRouter never uses another provider's key or the top-level key file", async (t) => {
  const f = setup(t, { extraEnv: { OPENROUTER_API_KEY: "" }, config: { key_file: "native-key" } });
  writeFileSync(path.join(f.dir, "native-key"), "fixture-native-file", { mode: 0o600 });
  for (const key of [undefined, { provider: "typesafe", value: "fixture-native" }, { provider: "vercel-ai-gateway", value: "fixture-gateway" }]) {
    const jev = f.open({ key });
    assert.equal(jev.status().keyEnv, "OPENROUTER_API_KEY");
    await assert.rejects(ask(jev), /OpenRouter API key is needed/);
  }
  assert.equal(f.sent.length, 0);
  for (const env of ["TYPESAFE_API_KEY", "AI_GATEWAY_API_KEY"]) assert.throws(() => f.open({ key: { provider: "openrouter", env } }), /another provider's key variable/);
  const own = setup(t, { extraEnv: { OPENROUTER_API_KEY: "" }, config: { openrouter: { key_file: "router-key" } } });
  writeFileSync(path.join(own.dir, "router-key"), "fixture-router-file", { mode: 0o600 });
  await ask(own.open());
  await ask(own.open({ key: { provider: "openrouter", value: "fixture-router-memory" } }));
  assert.deepEqual(own.sent.filter(({ url }) => url === ENDPOINT).map(({ init }) => init.headers.Authorization), ["Bearer fixture-router-file", "Bearer fixture-router-memory"]);
  assert.throws(() => setup(t, { config: { openrouter: { endpoint: "https://other.invalid" } } }).open(), /only its key_file/);
});

for (const status of [429, 503]) {
  test(`ZDR is re-enforced and eligibility re-fetched on the HTTP ${status} retry`, async (t) => {
    let attempts = 0;
    const f = setup(t, { answer: () => ++attempts === 1 ? new Response("private upstream error", { status, headers: { "retry-after-ms": "1" } }) : response() });
    const run = f.open({ maxRetries: 1 }).run({ customerValues: "zdr" });
    const body = { ...request({ name: "Example Person", email: "example@example.test" }), model: PINNED_MODEL };
    await run.ask(body);
    await run.close();
    assert.deepEqual(f.sent.map(({ url }) => url), [CATALOG, ENDPOINT, CATALOG, ENDPOINT]);
    for (const { body, init } of f.sent.filter(({ url }) => url === ENDPOINT)) {
      assert.deepEqual(body.provider, policy);
      assert.equal(body.model, MODEL);
      assert.equal(body.state.email, "example@example.test");
      assert.equal(init.headers.Authorization, "Bearer fixture-openrouter");
    }
    assert.equal(run.summary().committed_usd, usdFor(275) + (status === 503 ? usdFor(MAX_INPUT_TOKENS) : 0));
    const limits = JSON.parse(readFileSync(path.join(f.dir, "decision-gate/limits/openrouter/accounts/default.json"), "utf8"));
    assert.equal(limits.starts.length, 2);
    assert.deepEqual(limits.inFlight, []);
  });
}

test("a connection retry repeats catalog verification and books the uncertain attempt", async (t) => {
  let attempts = 0;
  const f = setup(t, { answer: () => {
    if (++attempts === 1) throw new Error("private network detail");
    return response();
  } });
  const run = f.open({ maxRetries: 1 }).run();
  await run.ask(request());
  await run.close();
  assert.deepEqual(f.sent.map(({ url }) => url), [CATALOG, ENDPOINT, CATALOG, ENDPOINT]);
  assert.equal(run.summary().committed_usd, usdFor(MAX_INPUT_TOKENS) + usdFor(275));
  assert.ok(f.sent.filter(({ url }) => url === ENDPOINT).every(({ body }) => JSON.stringify(body.provider) === JSON.stringify(policy)));
});

test("an abort during catalog verification never becomes a paid attempt", async (t) => {
  const controller = new AbortController();
  const reason = new Error("fixture cancellation");
  const f = setup(t, { catalog: ({ now }) => {
    controller.abort(reason);
    return new Response(JSON.stringify({ data: [eligible()] }), { headers: { date: new Date(now).toUTCString() } });
  } });
  const run = f.open().run();
  await assert.rejects(run.ask(request(), { signal: controller.signal }), (error) => error === reason);
  await run.close();
  assert.deepEqual(f.sent.map(({ url }) => url), [CATALOG]);
  assert.equal(run.summary().committed_usd, 0);
});

test("caller provider preferences are refused rather than replaced", async (t) => {
  for (const provider of [{ zdr: false, data_collection: "allow", allow_fallbacks: true, only: ["other"], order: ["other"] }, policy, null]) {
    const f = setup(t);
    await assert.rejects(ask(f.open(), { ...request(), provider }, { customerValues: "zdr" }), /own ZDR provider preferences; remove the request's provider field/);
    assert.equal(f.sent.length, 0);
  }
});

test("a pause recorded while eligibility is being checked delays the send and repeats the check", async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let checks = 0;
  const f = setup(t, {
    catalog: async () => {
      if (++checks === 1) await held;
      return new Response(JSON.stringify({ data: [eligible()] }), { headers: { date: new Date(f.time.now()).toUTCString() } });
    },
    answer: ({ sent }) => sent.filter(({ url }) => url === ENDPOINT).length === 1 ? new Response("private error", { status: 429, headers: { "retry-after": "5" } }) : response()
  });
  const run = f.open().run();
  const first = run.ask(request());
  while (!checks) await new Promise((resolve) => setImmediate(resolve));
  const paused = f.time.now();
  await assert.rejects(run.ask(request()), /HTTP 429/);
  release();
  await first;
  await run.close();
  assert.deepEqual(f.sent.map(({ url }) => url), [CATALOG, CATALOG, ENDPOINT, CATALOG, ENDPOINT]);
  assert.ok(f.time.now() >= paused + 5000);
  const limits = JSON.parse(readFileSync(path.join(f.dir, "decision-gate/limits/openrouter/accounts/default.json"), "utf8"));
  assert.equal(limits.starts.length, 2);
  assert.ok(limits.starts.at(-1).at >= paused + 5000);
});

for (const [name, lockedChecks] of Object.entries({ refreshed: 1, refused: 2 })) {
  test(`eligibility that expires while waiting for the limiter's lock is ${name}`, async (t) => {
    let now = Date.UTC(2026, 9, 13, 18), lock, heldUntil = 0, checks = 0;
    const time = { now: () => now, sleep: async (ms) => {
      now += ms;
      if (lock && now >= heldUntil) { rmSync(lock, { recursive: true, force: true }); lock = undefined; }
    } };
    const f = setup(t, { catalog: () => {
      // Another live process holds the limiter's lock for a second past this check's last fresh moment
      if (++checks <= lockedChecks) {
        lock = path.join(f.dir, "decision-gate/limits/openrouter/accounts/default.json.lock");
        mkdirSync(lock);
        writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ host: hostname(), pid: 1, token: randomUUID() }));
        heldUntil = now + 1000;
      }
      return new Response(JSON.stringify({ data: [eligible()] }), { headers: { date: new Date(now - 59500).toUTCString() } });
    } });
    const run = f.open({ time }).run();
    const asked = run.ask(request());
    if (lockedChecks === 1) await asked;
    else await assert.rejects(asked, /eligibility expired before sending/);
    await run.close();
    assert.deepEqual(f.sent.map(({ url }) => url), lockedChecks === 1 ? [CATALOG, CATALOG, ENDPOINT] : [CATALOG, CATALOG]);
    assert.equal(run.summary().committed_usd, lockedChecks === 1 ? usdFor(275) : 0);
  });
}

test("metadata, logging, plugins, fallback models and unknown fields cannot reach OpenRouter", async (t) => {
  for (const [key, value] of Object.entries({ metadata: { logging: true }, models: ["other"], plugins: [{ id: "broadcast" }], route: "fallback", log: true, usage: { include: true } })) {
    const f = setup(t);
    await assert.rejects(ask(f.open(), { ...request(), [key]: value }), /unsupported fields/);
    assert.equal(f.sent.length, 0);
  }
  const f = setup(t);
  const body = request();
  body.questions.q.metadata = { logging: true };
  await assert.rejects(ask(f.open(), body), /unsupported question/);
  assert.equal(f.sent.length, 0);
});

const catalogCases = {
  missing: () => ({ data: [] }),
  changed: () => ({ data: [{ ...eligible(), name: "TypeSafe | typesafe/jev-1.14-20261013" }] }),
  provider: () => ({ data: [{ ...eligible(), provider_name: "Other" }] }),
  tag: () => ({ data: [{ ...eligible(), tag: "other" }] }),
  duplicate: () => ({ data: [eligible(), eligible()] }),
  price: () => ({ data: [{ ...eligible(), pricing: { prompt: "0.00001", completion: "0" } }] }),
  limits: () => ({ data: [{ ...eligible(), max_prompt_tokens: 16000 }] }),
  malformed: () => ({ data: {} }),
  unrelated: () => ({ data: [{ ...eligible(), model_id: "typesafe/jev-latest" }] })
};
for (const [name, build] of Object.entries(catalogCases)) {
  test(`the ${name} ZDR catalog refuses without any paid attempt or spend`, async (t) => {
    const f = setup(t, { catalog: ({ now }) => new Response(JSON.stringify(build()), { headers: { date: new Date(now).toUTCString() } }) });
    const run = f.open({ maxRetries: 2 }).run({ customerValues: "zdr" });
    await assert.rejects(run.ask(request("example@example.test")), /ZDR catalog|ZDR eligibility/);
    await run.close();
    assert.deepEqual(f.sent.map(({ url }) => url), [CATALOG]);
    assert.equal(run.summary().committed_usd, 0);
  });
}

for (const [name, catalog] of Object.entries({
  stale: ({ now }) => new Response(JSON.stringify({ data: [eligible()] }), { headers: { date: new Date(now - 61000).toUTCString() } }),
  undated: () => new Response(JSON.stringify({ data: [eligible()] })),
  future: ({ now }) => new Response(JSON.stringify({ data: [eligible()] }), { headers: { date: new Date(now + 10000).toUTCString() } }),
  aged: ({ now }) => new Response(JSON.stringify({ data: [eligible()] }), { headers: { date: new Date(now).toUTCString(), age: "61" } }),
  "invalid-age": ({ now }) => new Response(JSON.stringify({ data: [eligible()] }), { headers: { date: new Date(now).toUTCString(), age: "nonsense" } }),
  delayed: ({ now, advance }) => { advance(61000); return new Response(JSON.stringify({ data: [eligible()] }), { headers: { date: new Date(now).toUTCString() } }); },
  redirect: () => new Response("", { status: 302, headers: { location: "https://other.invalid" } }),
  unavailable: () => new Response("private catalog error", { status: 503 }),
  unreadable: () => new Response("not JSON"),
  disconnected: () => { throw new Error("private network error"); }
})) {
  test(`a ${name} catalog is unverifiable and fails closed`, async (t) => {
    const f = setup(t, { catalog });
    await assert.rejects(ask(f.open()), /ZDR/);
    assert.deepEqual(f.sent.map(({ url }) => url), [CATALOG]);
  });
}

test("retry cannot reuse eligibility when the pinned endpoint disappears", async (t) => {
  let checks = 0;
  const f = setup(t, {
    catalog: ({ now }) => new Response(JSON.stringify({ data: ++checks === 1 ? [eligible()] : [] }), { headers: { date: new Date(now).toUTCString() } }),
    answer: () => new Response("private error", { status: 503, headers: { "retry-after-ms": "1" } })
  });
  const run = f.open({ maxRetries: 2 }).run();
  await assert.rejects(run.ask(request()), /pinned endpoint/);
  await run.close();
  assert.deepEqual(f.sent.map(({ url }) => url), [CATALOG, ENDPOINT, CATALOG]);
  assert.equal(run.summary().committed_usd, usdFor(MAX_INPUT_TOKENS));
});

test("contacts are allowed only in an explicit enforced ZDR run; defaults and custom prohibitions remain", async (t) => {
  const f = setup(t);
  const jev = f.open();
  assert.equal(jev.redactor.clean("example@example.test"), false);
  await assert.rejects(ask(jev, request("example@example.test")), /never-send/);
  assert.equal(f.sent.length, 0);
  const body = request({ name: "Example Person", email: "example@example.test", address: "123 Example Street", phone: "202-555-0100" });
  await ask(jev, body, { customerValues: "zdr" });
  assert.deepEqual(f.sent.at(-1).body.state, body.state);
  await assert.rejects(ask(jev, body), /never-send/);
  for (const provider of ["typesafe", "vercel-ai-gateway"]) {
    const other = setup(t, { config: { provider } });
    assert.throws(() => other.open().run({ customerValues: "zdr" }), /requires the enforced OpenRouter/);
    await assert.rejects(ask(other.open(), body), /never-send/);
    assert.equal(other.sent.length, 0);
  }
  assert.throws(() => jev.run({ customerValues: true }), /customerValues/);
  const file = path.join(f.dir, "never-send.json");
  writeFileSync(file, JSON.stringify({ rules: [], forbidden: ["example@example\\.test"] }), { mode: 0o600 });
  await assert.rejects(ask(f.open({ neverSend: file }), body, { customerValues: "zdr" }), /never-send/);
});

test("credentials in state, questions or field names are refused in default and ZDR runs", async (t) => {
  const f = setup(t);
  for (const customerValues of ["never-send", "zdr"]) {
    for (const text of ["Bearer abcdefghijklmnopqrst", "sk-or-v1-" + "a1".repeat(32), "SK-OR-V1-" + "A1".repeat(32), "password='private-value'", "ghp_" + "a1".repeat(20), "fixture-openrouter"]) {
      for (const body of [request(text), { ...request(), questions: { q: { type: "noul", instructions: text } } }, request({ [text]: "public" })]) {
        await assert.rejects(ask(f.open(), body, { customerValues }), /never-send/);
      }
    }
  }
  assert.equal(f.sent.length, 0);
});

test("approved response identities pass; other model, provider and caller model identities fail", async (t) => {
  for (const model of [MODEL, VERSION]) {
    for (const caller of [undefined, PINNED_MODEL]) await ask(setup(t, { answer: () => response({ model }) }).open(), { ...request(), model: caller });
  }
  for (const fields of [{ model: PINNED_MODEL }, { model: "~typesafe/jev-latest" }, { model: "typesafe/jev-1.13-20261013" }, { model: "typesafe-ai/jev" }, { provider: "Other" }, { provider: undefined }]) {
    const f = setup(t, { answer: () => response(fields) });
    await assert.rejects(ask(f.open()), /unexpected model or provider/);
    assert.equal(f.sent.length, 2);
  }
  for (const model of [MODEL, VERSION, "typesafe-ai/jev"]) {
    const f = setup(t);
    await assert.rejects(ask(f.open(), { ...request(), model }), /model must be/);
    assert.equal(f.sent.length, 0);
  }
});

test("all three typed answers are validated against the requested question keys and criteria", async (t) => {
  const body = { state: "public", questions: { q: { type: "noul" }, c: { type: "choice", criteria: { yes: null, no: null } }, s: { type: "score", criteria: ["Low", "High"] } } };
  const answers = { q: { type: "noul", noul: 0.8 }, c: { type: "choice", choice: "yes", confidence: 0.6, probabilities: { yes: 0.8, no: 0.2 } }, s: { type: "score", score: 0.8, confidence: 0.6, probabilities: { 0: 0.2, 1: 0.8 }, legend: { 0: "Low", 1: "High" } } };
  await ask(setup(t, { answer: () => response({ answers }) }).open(), body);
  const mutations = [
    (a) => { delete a.q; }, (a) => { a.extra = a.q; }, (a) => { a.q.type = "choice"; },
    (a) => { a.q.noul = 1.1; }, (a) => { a.q.noul = -0.1; }, (a) => { a.q.noul = "0.8"; },
    (a) => { a.c.choice = "other"; }, (a) => { a.c.choice = "no"; }, (a) => { a.c.confidence = 2; },
    (a) => { delete a.c.probabilities.no; }, (a) => { a.c.probabilities.other = 0; },
    (a) => { a.c.probabilities.yes = 0.4; }, (a) => { a.c.probabilities.yes = null; },
    (a) => { a.s.score = 2; }, (a) => { a.s.score = 0.5; }, (a) => { a.s.legend[0] = "Changed"; },
    (a) => { a.s.confidence = null; }, (a) => { a.q.text = "private echo"; }
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(answers);
    mutate(bad);
    await assert.rejects(ask(setup(t, { answer: () => response({ answers: bad }) }).open(), body), /invalid typed answers/);
  }
});

test("OpenRouter refuses oversized requests locally using its catalog's model limits", async (t) => {
  const f = setup(t);
  await assert.rejects(ask(f.open(), request("x".repeat(129000))), /32000-token/);
  assert.equal(f.sent.length, 0);
});

test("invalid responses are still charged, and diagnostics and persisted records carry no values", async (t) => {
  const secret = "example@example.test";
  const f = setup(t, { answer: () => response({ model: secret }) });
  const run = f.open().run({ customerValues: "zdr" });
  await assert.rejects(run.ask(request(secret)), (error) => {
    assert.ok(!describeError(error).includes(secret));
    assert.ok(!describeError(error).includes("fixture-openrouter"));
    return /unexpected model/.test(error.message);
  });
  await run.close();
  assert.equal(run.summary().committed_usd, usdFor(275));
  const ledgers = path.join(f.dir, "decision-gate/spend/openrouter");
  const stored = readdirSync(ledgers).map((name) => readFileSync(path.join(ledgers, name), "utf8")).join("");
  assert.ok(!stored.includes(secret));
  assert.ok(!stored.includes("fixture-openrouter"));
});
