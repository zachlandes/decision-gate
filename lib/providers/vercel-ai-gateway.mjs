import { JEV_PRICE, systemOneProvider } from "./typesafe.mjs";

// Experimental and unpinned: the gate sends this floating id, so the Jev version behind it can change
export const GATEWAY_MODEL = "typesafe-ai/jev";

export const vercelAiGateway = systemOneProvider({
  name: "vercel-ai-gateway",
  label: "Vercel AI Gateway",
  keyEnv: "AI_GATEWAY_API_KEY",
  // The one endpoint the gate posts to, with TypeSafe's request and response shapes
  endpoint: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
  wireModel: GATEWAY_MODEL,
  pinned: false,
  // Booked at TypeSafe's list price
  price: { ...JEV_PRICE, model: GATEWAY_MODEL, source: "https://vercel.com/ai-gateway/models/jev", checked: "2026-09-26" },
  // Conservative guesses rather than measurements
  limits: { requestsPerMinute: 60, tokensPerSecond: 250000, inFlight: 2 },
  maxRetries: 1,
  pauseFallbackMs: 5000
});
