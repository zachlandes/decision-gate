import { typesafe } from "./typesafe.mjs";
import { vercelAiGateway } from "./vercel-ai-gateway.mjs";

// A provider must have a known price and typed probabilities before it can own requests, since
// the ceilings and callers' thresholds depend on both; state is filed under its name so adding
// one needs no migration
export const providers = Object.freeze({ [typesafe.name]: typesafe, [vercelAiGateway.name]: vercelAiGateway });
export const DEFAULT_PROVIDER = typesafe.name;
