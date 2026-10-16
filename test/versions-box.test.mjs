import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ALLOWED_MODELS, PINNED_MODEL, openJev, usdFor } from "../lib/index.mjs";

const latest = "jev-1.14.0";
const wire = (provider, model = PINNED_MODEL) => provider === "typesafe" ? model : provider === "openrouter" ? `typesafe/jev-${model === latest ? "1.14" : "1.13"}` : `typesafe-ai/${model}`;
const endpointVersion = (model) => model.endsWith("1.14") ? "typesafe/jev-1.14-20261014" : "typesafe/jev-1.13-20260917";
const request = (model) => ({ model, state: "A red square", questions: { present: { type: "noul", instructions: "Is a red square described?" } } });
const boxAnswer = () => ({ type: "box", box: { top: 0.2, bottom: 0.8, left: 0.3, right: 0.7 }, confidence: 0.92 });
const boxRequest = (model = latest) => ({
  model,
  state: { photo: "fixture-asset-unique" },
  assets: { "fixture-asset-unique": { type: "image", format: "png", data_base64: "aW1hZ2U=" } },
  questions: {
    present: { type: "noul", instructions: "Is there a red square in `photo`?" },
    target: { type: "box", instructions: "the red square in `photo`" }
  }
});

function setup(t, provider = "typesafe", answer) {
  const dir = mkdtempSync(path.join(tmpdir(), "decision-gate-versions-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sent = [], notices = [], checks = [];
  const env = { XDG_CONFIG_HOME: dir, XDG_STATE_HOME: dir, XDG_CACHE_HOME: dir, DECISION_GATE_PROVIDER: provider, TYPESAFE_API_KEY: "fixture-typesafe-key", AI_GATEWAY_API_KEY: "fixture-gateway-key", OPENROUTER_API_KEY: "fixture-openrouter-key" };
  const fetch = async (url, init) => {
    if (url === "https://openrouter.ai/api/v1/endpoints/zdr") {
      checks.push({ url, init });
      return new Response(JSON.stringify({ data: [PINNED_MODEL, latest].map((version) => ({ name: `TypeSafe | ${endpointVersion(wire(provider, version))}`, model_id: wire(provider, version), provider_name: "TypeSafe", tag: "typesafe", pricing: { prompt: "0.000000042", completion: "0" }, context_length: 262144, max_prompt_tokens: 262144 })) }), { headers: { date: new Date().toUTCString() } });
    }
    const body = JSON.parse(init.body);
    sent.push({ url, headers: new Headers(init.headers), body });
    if (answer) return answer(body, sent.length);
    return new Response(JSON.stringify({ model: body.model, ...(provider === "openrouter" ? { provider: "TypeSafe" } : {}), answers: Object.fromEntries(Object.entries(body.questions).map(([id, q]) => [id, q.type === "box" ? boxAnswer() : { type: "noul", noul: 0.9 }])), usage: { input_tokens: 123, output_tokens: 21 } }));
  };
  const open = (options = {}) => openJev({ env, fetch, tool: "fixture", notice: (line) => notices.push(line), maxRetries: 0, ...options });
  return { open, sent, notices, checks };
}

async function ask(jev, body, options) {
  const run = jev.run();
  try { return await run.ask(body, options); }
  finally { await run.close(); }
}

test("exact model versions are sent, returned, and logged on every route", async (t) => {
  assert.equal(PINNED_MODEL, "jev-1.13.0");
  assert.deepEqual(ALLOWED_MODELS, [PINNED_MODEL, latest]);
  assert.ok(Object.isFrozen(ALLOWED_MODELS));
  for (const provider of ["typesafe", "vercel-ai-gateway", "openrouter"]) {
    const f = setup(t, provider), jev = f.open();
    for (const model of [undefined, PINNED_MODEL, latest]) {
      const expected = wire(provider, model);
      const result = await ask(jev, request(model));
      assert.equal(f.sent.at(-1).body.model, expected);
      assert.equal(result.model, expected);
      assert.ok(f.notices.at(-1).endsWith(`answered with model ${expected}`));
    }
    const selected = f.open({ model: latest });
    assert.equal(selected.config.modelVersion, latest);
    assert.equal(selected.config.model, wire(provider, latest));
    assert.equal(selected.config.pinned, true);
    assert.equal((await ask(selected, request())).model, selected.config.model);
    assert.equal((await ask(selected, request(PINNED_MODEL))).model, jev.config.model);
  }
});

test("aliases and non-allowlisted ids fail before keys, spend, cache writes, or fetch", async (t) => {
  for (const provider of ["typesafe", "vercel-ai-gateway", "openrouter"]) {
    const f = setup(t, provider), jev = f.open();
    for (const model of ["jev-latest", "jev-preview", "jev-1.15.0", "jev-1.14", "typesafe-ai/jev", null, "", "__proto__"]) {
      assert.throws(() => f.open({ model }), /floating aliases and other ids are refused/);
      assert.throws(() => jev.cache({ model }), /floating aliases and other ids are refused/);
      await assert.rejects(ask(jev, request(model)), /floating aliases and other ids are refused/);
    }
    assert.equal(f.sent.length, 0);
  }
});

test("OpenRouter reports the dated answering version and validates the requested route", async (t) => {
  const f = setup(t, "openrouter", (body) => new Response(JSON.stringify({ model: endpointVersion(body.model), provider: "TypeSafe", answers: { present: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 123 } })));
  for (const model of ALLOWED_MODELS) {
    const result = await ask(f.open(), request(model));
    assert.equal(result.model, endpointVersion(wire("openrouter", model)));
    assert.ok(f.notices.at(-1).endsWith(`answered with model ${result.model}`));
    assert.deepEqual(f.sent.at(-1).body.provider, { zdr: true, data_collection: "deny", allow_fallbacks: false, only: ["typesafe"] });
  }
  assert.equal(f.checks.length, 2);
});

test("the answering version must match the requested version and unexpected ids never enter notices", async (t) => {
  for (const provider of ["typesafe", "vercel-ai-gateway"]) {
    for (const model of [PINNED_MODEL, latest, "jev-preview", "private-response-text"]) {
      const f = setup(t, provider, () => new Response(JSON.stringify({ model, usage: { input_tokens: 123 } })));
      const run = f.open().run();
      const wanted = model === latest ? PINNED_MODEL : latest;
      await assert.rejects(run.ask(request(wanted)), /unexpected model/);
      await run.close();
      assert.equal(run.summary().committed_usd, usdFor(123));
      assert.deepEqual(f.notices, []);
    }
  }
});

test("caches separate versions, share explicit/default identities, and retain the selected caller version", async (t) => {
  for (const provider of ["typesafe", "vercel-ai-gateway", "openrouter"]) {
    const f = setup(t, provider), jev = f.open();
    const scope = { prompt: "fixture-v1" };
    await jev.cache({ scope }).put([["item", 0.13]]);
    assert.equal(jev.cache({ scope, model: PINNED_MODEL }).get("item"), 0.13);
    assert.equal(jev.cache({ scope, model: latest }).get("item"), undefined);
    await jev.cache({ scope, model: latest }).put([["item", 0.14]]);
    assert.equal(jev.cache({ scope }).get("item"), 0.13);
    const optIn = f.open({ model: latest });
    assert.equal(optIn.cache({ scope }).get("item"), 0.14);
    assert.equal(optIn.cache({ scope, model: PINNED_MODEL }).get("item"), 0.13);
  }
});

test("preview Box returns fractions and confidence, preserving the asset and Noul; only Box gets the header", async (t) => {
  for (const provider of ["typesafe", "vercel-ai-gateway", "openrouter"]) {
    const f = setup(t, provider), jev = f.open({ model: latest });
    await ask(jev, request(), { previewBox: true });
    const result = await ask(jev, boxRequest(), { previewBox: true });
    assert.deepEqual(result.answers.target, boxAnswer());
    assert.equal(result.answers.present.noul, 0.9);
    assert.equal(f.sent[0].headers.has("TypeSafe-Danger-Zone-Images"), false);
    assert.equal(f.sent[1].headers.get("TypeSafe-Danger-Zone-Images"), "true");
    assert.deepEqual(f.sent[1].body.assets, boxRequest().assets);
    assert.equal(Object.hasOwn(f.sent[1].body, "previewBox"), false);
    await ask(jev, request());
    assert.equal(f.sent[2].headers.has("TypeSafe-Danger-Zone-Images"), false);
  }
});

test("preview Box needs explicit opt-in, 1.14, image assets, and no criteria", async (t) => {
  const f = setup(t), jev = f.open();
  await assert.rejects(ask(jev, boxRequest()), /explicitly set previewBox: true/);
  await assert.rejects(ask(jev, boxRequest(), { previewBox: false }), /preview-only/);
  await assert.rejects(ask(jev, boxRequest(), { previewBox: "true" }), /must be a boolean/);
  for (const model of [undefined, PINNED_MODEL]) await assert.rejects(ask(jev, { ...boxRequest(), model }, { previewBox: true }), /requires jev-1.14.0/);
  for (const assets of [undefined, {}, { image: { part: "file" } }, { image: { format: "png", url: "https://example.test/photo.png" } }]) {
    await assert.rejects(ask(jev, { ...boxRequest(), assets }, { previewBox: true }), /image assets/);
  }
  for (const question of [{ type: "box" }, { type: "box", instructions: "target", criteria: {} }]) {
    await assert.rejects(ask(jev, { ...boxRequest(), questions: { target: question } }, { previewBox: true }), /need instructions and take no criteria/);
  }
  await assert.rejects(ask(jev, { ...boxRequest(), questions: request().questions }, { previewBox: true }), /only with preview Box/);
  assert.equal(f.sent.length, 0);
});

test("malformed Box answers fail closed after booking their usage", async (t) => {
  for (const change of [
    (a) => { a.type = "noul"; },
    (a) => { a.confidence = -0.1; },
    (a) => { a.confidence = "0.9"; },
    (a) => { a.box.top = -0.01; },
    (a) => { a.box.bottom = 1.1; },
    (a) => { a.box.left = a.box.right; },
    (a) => { a.box.top = a.box.bottom + 0.1; },
    (a) => { delete a.box.left; },
    (a) => { a.box.extra = 0; }
  ]) {
    const f = setup(t, "typesafe", (body) => {
      const answer = boxAnswer();
      change(answer);
      return new Response(JSON.stringify({ model: body.model, answers: { target: answer }, usage: { input_tokens: 123 } }));
    });
    const run = f.open().run();
    await assert.rejects(run.ask(boxRequest(), { previewBox: true }), /invalid preview Box/);
    await run.close();
    assert.equal(run.summary().committed_usd, usdFor(123));
    assert.deepEqual(f.notices, []);
  }
});

test("preview header and exact model survive a retry", async (t) => {
  const f = setup(t, "typesafe", (body, n) => n === 1
    ? new Response("{}", { status: 429, headers: { "retry-after-ms": "1" } })
    : new Response(JSON.stringify({ model: body.model, answers: { target: boxAnswer() }, usage: { input_tokens: 123 } })));
  await ask(f.open({ maxRetries: 1 }), boxRequest(), { previewBox: true });
  assert.equal(f.sent.length, 2);
  assert.ok(f.sent.every(({ body, headers }) => body.model === latest && headers.get("TypeSafe-Danger-Zone-Images") === "true"));
});
