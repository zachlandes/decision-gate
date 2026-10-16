import { JEV_PRICE, systemOneProvider } from "./typesafe.mjs";

// Exact versioned ids listed by https://ai-gateway.vercel.sh/v1/models
export const GATEWAY_MODEL = "typesafe-ai/jev-1.13.0";

export const vercelAiGateway = systemOneProvider({
  name: "vercel-ai-gateway",
  label: "Vercel AI Gateway",
  keyEnv: "AI_GATEWAY_API_KEY",
  // The one endpoint the gate posts to, with TypeSafe's request and response shapes
  endpoint: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
  wireModel: GATEWAY_MODEL,
  wireModels: { "jev-1.13.0": GATEWAY_MODEL, "jev-1.14.0": "typesafe-ai/jev-1.14.0" },
  pinned: true,
  // Booked at TypeSafe's list price
  price: { ...JEV_PRICE, model: GATEWAY_MODEL, source: "https://vercel.com/ai-gateway/models/jev", checked: "2026-10-16" },
  // Conservative guesses rather than measurements
  limits: { requestsPerMinute: 60, tokensPerSecond: 250000, inFlight: 2 },
  maxRetries: 1,
  pauseFallbackMs: 5000
});
