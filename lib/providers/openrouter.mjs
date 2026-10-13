import { isDeepStrictEqual } from "node:util";
import { ServiceError } from "../errors.mjs";
import { clock } from "../state.mjs";
import { JEV_PRICE, systemOneProvider } from "./typesafe.mjs";

const MODEL = "typesafe/jev-1.13";
const VERSION = "typesafe/jev-1.13-20260917";
const CATALOG = "https://openrouter.ai/api/v1/endpoints/zdr";
// Reject old HTTP cache entries and checks delayed by delivery, not just old local snapshots
const FRESH_MS = 60000;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const probability = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
const keysEqual = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const fail = (message) => { throw new ServiceError(`OpenRouter ${message}; no input or key logged`); };
const routing = () => ({ zdr: true, data_collection: "deny", allow_fallbacks: false, only: ["typesafe"] });

function prepare(request) {
  // An allowlist excludes logging, plugins, broadcasts, fallbacks and future passthrough fields
  if (!object(request) || Object.keys(request).some((key) => !["model", "state", "questions", "provider"].includes(key))) fail("request contains unsupported fields");
  if (!Object.hasOwn(request, "state") || !object(request.questions) || !Object.keys(request.questions).length) fail("request needs state and typed questions");
  for (const question of Object.values(request.questions)) {
    if (!object(question) || Object.keys(question).some((key) => !["type", "instructions", "criteria"].includes(key))) fail("request contains an unsupported question");
    if (question.type === "noul") {
      if (question.criteria != null && (!object(question.criteria) || Object.keys(question.criteria).some((key) => !["true", "false"].includes(key)))) fail("request contains invalid noul criteria");
    } else if (question.type === "choice") {
      if (!object(question.criteria) || Object.keys(question.criteria).length < 2 || Object.keys(question.criteria).length > 255) fail("request contains invalid choice criteria");
    } else if (question.type === "score") {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 10) fail("request contains invalid score criteria");
    } else fail("request contains an unsupported question type");
  }
  return { model: MODEL, state: request.state, questions: request.questions, provider: routing() };
}

async function beforeAttempt({ fetchImpl, signal, time = clock }) {
  const started = time.now();
  let response, catalog;
  try {
    response = await fetchImpl(CATALOG, { method: "GET", headers: { Accept: "application/json", "Cache-Control": "no-cache" }, cache: "no-store", redirect: "manual", signal });
    if (!response.ok) fail("ZDR eligibility is unverifiable");
    catalog = await response.json();
  } catch {
    fail("ZDR eligibility is unverifiable");
  }
  const now = time.now();
  const date = Date.parse(response.headers.get("date") ?? "");
  const ageHeader = response.headers.get("age");
  const age = ageHeader === null ? 0 : /^\d+$/.test(ageHeader) ? Number(ageHeader) * 1000 : NaN;
  // Allow five seconds of server clock skew, but never an undated or stale catalog
  if (!Number.isFinite(date) || !Number.isFinite(age) || age > FRESH_MS || now - date > FRESH_MS || date - now > 5000 || now - started > FRESH_MS || now < started) fail("ZDR catalog is stale or undated");
  if (!Array.isArray(catalog?.data)) fail("ZDR eligibility is unverifiable");
  // The broad TypeSafe route must have exactly one eligible endpoint for this model
  const matches = catalog.data.filter((entry) => entry?.model_id === MODEL && (entry.tag === "typesafe" || entry.provider_name === "TypeSafe"));
  const entry = matches[0];
  if (matches.length !== 1 || entry.name !== `TypeSafe | ${VERSION}` || entry.provider_name !== "TypeSafe" || entry.tag !== "typesafe") fail("pinned endpoint is missing or changed in the ZDR catalog");
  // Refuse price or capacity changes rather than weaken the spend reservation or size checks
  if (entry.pricing?.prompt !== "0.000000042" || entry.pricing?.completion !== "0" || entry.context_length !== 64000 || entry.max_prompt_tokens !== 32000) fail("pinned endpoint price or limits changed in the ZDR catalog");
  signal?.throwIfAborted();
}

function validate(json, request) {
  if (![MODEL, VERSION].includes(json?.model) || json?.provider !== "TypeSafe") fail("answered with an unexpected model or provider");
  const questions = request.questions;
  if (!keysEqual(json.answers, Object.keys(questions))) fail("answered with invalid typed answers");
  // Permit decimal rounding, not a malformed or incomplete probability distribution
  const tolerance = 0.001;
  for (const [id, question] of Object.entries(questions)) {
    const answer = json.answers[id];
    if (!object(answer) || answer.type !== question.type) fail("answered with invalid typed answers");
    if (question.type === "noul") {
      if (!keysEqual(answer, ["type", "noul"]) || !probability(answer.noul)) fail("answered with invalid typed answers");
      continue;
    }
    const keys = Object.keys(question.criteria);
    if (!probability(answer.confidence) || !keysEqual(answer.probabilities, keys) || !Object.values(answer.probabilities).every(probability) || Math.abs(Object.values(answer.probabilities).reduce((sum, p) => sum + p, 0) - 1) > tolerance) fail("answered with invalid typed answers");
    if (question.type === "choice") {
      if (!keysEqual(answer, ["type", "choice", "confidence", "probabilities"]) || typeof answer.choice !== "string" || !keys.includes(answer.choice) || answer.probabilities[answer.choice] < Math.max(...Object.values(answer.probabilities))) fail("answered with invalid typed answers");
    } else {
      const expected = keys.reduce((sum, key) => sum + Number(key) * answer.probabilities[key], 0);
      if (!keysEqual(answer, ["type", "score", "confidence", "probabilities", "legend"]) || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > keys.length - 1 || Math.abs(answer.score - expected) > tolerance || !keysEqual(answer.legend, keys) || keys.some((key) => !isDeepStrictEqual(answer.legend[key], question.criteria[key]))) fail("answered with invalid typed answers");
    }
  }
}

export const openrouter = systemOneProvider({
  name: "openrouter",
  label: "OpenRouter",
  keyEnv: "OPENROUTER_API_KEY",
  // OpenRouter's documented TypeSafe SDK surface, not its chat completions surface
  endpoint: "https://openrouter.ai/api/v1/systemone",
  wireModel: MODEL,
  pinned: true,
  fixedEndpoint: true,
  customerValues: true,
  price: { ...JEV_PRICE, model: MODEL, source: "https://openrouter.ai/typesafe/jev-1.13", checked: "2026-10-13" },
  limits: { requestsPerMinute: 60, tokensPerSecond: 250000, inFlight: 2 },
  maxInputTokens: 64000,
  maxStateQuestionTokens: 32000,
  policy: { prepare, beforeAttempt, validate }
});
