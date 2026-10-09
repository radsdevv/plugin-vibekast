import { formatUnits } from "viem";
import { DECIMALS, EXPLORER_TX_URL, QUANTILE_LEVELS } from "./constants";

export const units = (wei: bigint) => Number(formatUnits(wei, DECIMALS));

/** ETH with 3 significant digits, e.g. 0.0000997 — enough to judge gas, short enough to read. */
export const ethAmount = (value: bigint | string) => {
  const eth = typeof value === "bigint" ? Number(formatUnits(value, 18)) : Number(value);
  return eth === 0 ? "0" : String(Number(eth.toPrecision(3)));
};

export const round = (x: number, digits = 2) => Math.round(x * 10 ** digits) / 10 ** digits;

export const usd = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;

export const amount = (x: number) => round(x).toLocaleString("en-US", { maximumFractionDigits: 2 });

export const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const txUrl = (hash: string) => `${EXPLORER_TX_URL}${hash}`;

/**
 * Label for one price range, matching the settlement rule: the first range
 * takes everything below its upper edge, the last everything above its lower edge.
 */
export function rangeLabel(edges: number[], i: number): string {
  const n = edges.length - 1;
  if (i === 0) return `below ${usd(edges[1])}`;
  if (i === n - 1) return `${usd(edges[i])} and above`;
  return `${usd(edges[i])} to ${usd(edges[i + 1])}`;
}

/** The crowd's forecast as prices at QUANTILE_LEVELS, read off the book's piecewise-linear CDF. */
export function crowdQuantiles(edges: number[], prices: number[]): number[] {
  const total = prices.reduce((s, p) => s + p, 0);
  return QUANTILE_LEVELS.map(level => {
    const target = (level / 100) * total;
    let cumulative = 0;
    for (let i = 0; i < prices.length; i++) {
      if (cumulative + prices[i] >= target && prices[i] > 0) {
        const within = (target - cumulative) / prices[i];
        return edges[i] + within * (edges[i + 1] - edges[i]);
      }
      cumulative += prices[i];
    }
    return edges[edges.length - 1];
  });
}

export function closesIn(closeTimeIso: string, now = Date.now()): string {
  const ms = Date.parse(closeTimeIso) - now;
  if (ms <= 0) return "closed";
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 48) return `${Math.floor(hours / 24)} days`;
  if (hours >= 1) return `${hours} hours`;
  return `${Math.max(1, Math.floor(ms / 60_000))} minutes`;
}

export function closeLabel(closeTimeIso: string): string {
  const d = new Date(closeTimeIso);
  const day = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
  const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });
  return `${day} at ${time} UTC`;
}
