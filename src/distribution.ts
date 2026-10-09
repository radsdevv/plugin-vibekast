import { QUANTILE_LEVELS } from "./constants";

// Mirrors lib/league/distribution.ts on vibekast.xyz so a quantile forecast
// turns into the same per-range probabilities the server would compute.

const LEVELS = QUANTILE_LEVELS.map(level => level / 100);

function normalize(p: readonly number[]): number[] {
  const clipped = p.map(x => (Number.isFinite(x) && x > 0 ? x : 0));
  const total = clipped.reduce((s, x) => s + x, 0);
  if (!(total > 0)) return clipped.map(() => 1 / clipped.length);
  return clipped.map(x => x / total);
}

/**
 * Quantiles to a piecewise-linear CDF. The 5% tails extend as far beyond the
 * 5th/95th percentile as the 5th–25th / 75th–95th span.
 */
function quantileCdf(quantiles: readonly number[]): (x: number) => number {
  const q = [...quantiles].sort((a, b) => a - b);
  const eps = Math.max(1e-6, Math.abs(q[3]) * 1e-6);
  for (let i = 1; i < q.length; i++) if (q[i] <= q[i - 1]) q[i] = q[i - 1] + eps;
  const xs = [q[0] - (q[2] - q[0]), ...q, q[6] + (q[6] - q[4])];
  const ps = [0, ...LEVELS, 1];
  return x => {
    if (x <= xs[0]) return 0;
    if (x >= xs[xs.length - 1]) return 1;
    let i = 1;
    while (x > xs[i]) i++;
    const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
    return ps[i - 1] + t * (ps[i] - ps[i - 1]);
  };
}

/**
 * One probability per price range. `edges` are the market's n + 1 range edges;
 * the first and last ranges absorb the tails, matching settlement.
 */
export function probsFromQuantiles(quantiles: readonly number[], edges: readonly number[]): number[] {
  if (quantiles.length !== LEVELS.length || quantiles.some(q => !Number.isFinite(q))) {
    throw new Error(`expected ${LEVELS.length} finite quantiles`);
  }
  const cdf = quantileCdf(quantiles);
  const inner = edges.slice(1, -1);
  const at = [0, ...inner.map(x => Math.min(1, Math.max(0, cdf(x)))), 1];
  for (let i = 1; i < at.length; i++) at[i] = Math.max(at[i], at[i - 1]);
  return normalize(Array.from({ length: edges.length - 1 }, (_, i) => at[i + 1] - at[i]));
}
