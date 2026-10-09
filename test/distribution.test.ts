import { describe, expect, it } from "vitest";
import { probsFromQuantiles } from "../src/distribution";

const edges = Array.from({ length: 27 }, (_, i) => 64_000 + i * 2_000);
const sum = (p: number[]) => p.reduce((s, x) => s + x, 0);

describe("probsFromQuantiles", () => {
  it("returns one probability per range that sums to 1", () => {
    const p = probsFromQuantiles([75000, 76400, 78800, 81600, 84500, 87200, 88800], edges);
    expect(p).toHaveLength(26);
    expect(sum(p)).toBeCloseTo(1, 12);
    expect(p.every(x => x >= 0)).toBe(true);
  });

  it("puts half the mass below the median", () => {
    const p = probsFromQuantiles([70000, 72000, 76000, 80000, 84000, 88000, 90000], edges);
    const belowMedian = sum(p.slice(0, (80_000 - 64_000) / 2_000));
    expect(belowMedian).toBeCloseTo(0.5, 9);
  });

  it("lets the edge ranges absorb the tails", () => {
    const p = probsFromQuantiles([40000, 42000, 44000, 46000, 48000, 50000, 52000], edges);
    expect(p[0]).toBeCloseTo(1, 12);
  });

  it("tolerates repeated or unsorted prices", () => {
    const p = probsFromQuantiles([81000, 80000, 80000, 80000, 80000, 80000, 79000], edges);
    expect(sum(p)).toBeCloseTo(1, 12);
    expect(Math.max(...p)).toBeGreaterThan(0.5);
  });

  it("rejects the wrong number of prices", () => {
    expect(() => probsFromQuantiles([1, 2, 3], edges)).toThrow("7 finite quantiles");
  });
});
