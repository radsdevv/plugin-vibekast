import type { MarketInfo } from "./client";
import { ORDER_LIMITS, QUALIFYING_BUDGET, QUANTILE_LEVELS } from "./constants";
import { closeLabel, closesIn, crowdQuantiles, usd } from "./format";

export interface ForecastParams {
  quantiles: number[];
  budget: number;
}

export interface RegistrationParams {
  name: string;
  url: string | null;
  description: string | null;
}

const tag = (xml: string, name: string): string | null => {
  const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"));
  const value = match?.[1].trim();
  return value && value.toLowerCase() !== "null" ? value : null;
};

const number = (raw: unknown): number | null => {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const value = Number(raw.replace(/[$,\s]/g, ""));
  return raw.trim() !== "" && Number.isFinite(value) ? value : null;
};

/** Validates a forecast from either the model's reply or planner parameters. */
export function toForecast(rawQuantiles: unknown[], rawBudget: unknown): ForecastParams | null {
  const quantiles = rawQuantiles.map(number);
  if (quantiles.length !== QUANTILE_LEVELS.length || quantiles.some(q => q === null || q <= 0)) return null;
  const sorted = (quantiles as number[]).slice().sort((a, b) => a - b);
  if (sorted.some((q, i) => i > 0 && q <= sorted[i - 1])) return null;
  const budget = number(rawBudget) ?? ORDER_LIMITS.defaultBudget;
  return {
    quantiles: sorted.map(q => Math.round(q)),
    budget: Math.min(ORDER_LIMITS.maxBudget, Math.max(ORDER_LIMITS.minBudget, budget)),
  };
}

export function forecastPrompt(conversation: string, m: MarketInfo, now = Date.now()): string {
  const crowd = crowdQuantiles(m.edges, m.prices);
  const levels = QUANTILE_LEVELS.map(level => `    <p${level}>number</p${level}>`).join("\n");
  return `You are placing a forecast on VibeKast, a market on where Bitcoin's price will settle at the weekly close.

Market:
- Question: ${m.question}
- Closes: ${closeLabel(m.closeTimeIso)} (in ${closesIn(m.closeTimeIso, now)})
- Latest BTC/USD: ${m.spot ? usd(m.spot.price) : "unknown"}
- Settlement: ${m.settlement}
- Tradable price ranges run from ${usd(m.edges[0])} to ${usd(m.edges[m.edges.length - 1])}.
- The crowd's current forecast (5th to 95th percentile): ${crowd.map(usd).join(", ")}

Conversation:
${conversation}

Give a forecast as BTC prices in USD at the 5th, 10th, 25th, 50th, 75th, 90th and 95th percentiles, lowest first.
If the user stated a forecast, use it. Otherwise form your own calibrated view: center it near the latest price unless you have a reason not to, and size the spread for the time left (Bitcoin typically moves 3 to 5 percent in a week). Forecasts are scored on calibration, so do not just copy the crowd and do not make it overconfident.
Budget: use the amount of test USDC (tUSDC) the user asked to spend. If they gave none, use ${QUALIFYING_BUDGET}. It must be between ${ORDER_LIMITS.minBudget} and ${ORDER_LIMITS.maxBudget}.

Reply with only this XML, using plain numbers without commas or dollar signs:
<response>
${levels}
    <budget>number</budget>
</response>`;
}

export function parseForecast(xml: string): ForecastParams | null {
  return toForecast(
    QUANTILE_LEVELS.map(level => tag(xml, `p${level}`)),
    tag(xml, "budget"),
  );
}

export function registrationPrompt(conversation: string, defaultName: string): string {
  return `Register this AI agent on the VibeKast leaderboard.

Conversation:
${conversation}

Pick the agent's public name: the name the user asked for, otherwise "${defaultName}". It must be 3 to 32 characters.
Include a website only if the user gave an https URL, and a one-line description only if the user gave one.

Reply with only this XML:
<response>
    <name>string</name>
    <url>https URL or null</url>
    <description>string or null</description>
</response>`;
}

export function parseRegistration(xml: string, defaultName: string): RegistrationParams {
  const url = tag(xml, "url");
  return {
    name: tag(xml, "name") ?? defaultName,
    url: url && /^https:\/\//i.test(url) ? url : null,
    description: tag(xml, "description"),
  };
}
