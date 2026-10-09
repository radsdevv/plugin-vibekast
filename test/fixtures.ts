import { encodeFunctionData, type Hex } from "viem";
import { vi } from "vitest";
import { VibeKastClient, type ChainReader, type WalletSigner } from "../src/client";
import { COLLATERAL_ABI, MARKET_ABI } from "../src/constants";

export const WALLET = "0x1111111111111111111111111111111111111111" as Hex;
export const MARKET = "0x2222222222222222222222222222222222222222" as Hex;
export const COLLATERAL = "0x3333333333333333333333333333333333333333" as Hex;
export const OLD_MARKET = "0x4444444444444444444444444444444444444444" as Hex;
export const STRANGER = "0x5555555555555555555555555555555555555555" as Hex;
export const TX_HASH = `0x${"ab".repeat(32)}` as Hex;
export const WAD = 10n ** 18n;
export const N = 4;

export const MARKET_RESPONSE = {
  market: MARKET,
  collateral: COLLATERAL,
  label: "2026-W41",
  question: "Where will BTC close on Sunday 11 Oct 23:59 UTC?",
  closeTimeIso: "2026-10-11T23:59:00.000Z",
  open: true,
  n: N,
  edges: [60000, 62000, 64000, 66000, 68000],
  prices: [0.1, 0.4, 0.3, 0.2],
  feeBps: 100,
  spot: { price: 63000, updatedAt: 1 },
  settlement: "Chainlink BTC/USD, 2h TWAP",
};

export const QUANTILES = [61000, 61500, 62500, 63000, 63500, 64500, 65000];

export const approveTx = (spender: Hex = MARKET, amount: bigint = 5n * WAD) => ({
  to: COLLATERAL,
  data: encodeFunctionData({ abi: COLLATERAL_ABI, functionName: "approve", args: [spender, amount] }),
  value: "0",
  description: "Approve",
});

export const buyTx = (maxCost: bigint = 5n * WAD, to: Hex = MARKET) => ({
  to,
  data: encodeFunctionData({ abi: MARKET_ABI, functionName: "buy", args: [[0n, 3n * WAD, 2n * WAD, 0n], maxCost] }),
  value: "0",
  description: "Buy",
});

export const orderResponse = (transactions = [approveTx(), buyTx()], maxCostWad = 5n * WAD) => ({
  market: MARKET,
  shares: ["0", (3n * WAD).toString(), (2n * WAD).toString(), "0"],
  quote: { cost: 4.9, fee: 0.049, total: 4.949 },
  maxCost: { units: Number(maxCostWad) / 1e18, wad: maxCostWad.toString() },
  transactions,
});

export const reply = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as unknown as Response;

/** An in-memory chain: each contract read returns `chain[functionName]`, called with its args if it's a function. */
export function setup() {
  const chain: Record<string, unknown> = {
    latest: MARKET,
    count: 2n,
    marketAt: (i: bigint) => (i === 0n ? OLD_MARKET : MARKET),
    collateral: COLLATERAL,
    balanceOf: 10_000n * WAD,
    allowance: 10_000n * WAD,
    balanceOfBatch: [0n, 0n, 0n, 0n],
    resolved: false,
    voided: false,
    winningBucket: 1n,
    n: BigInt(N),
  };
  const reader = {
    readContract: vi.fn(
      async ({ functionName, args }: { address: Hex; functionName: string; args?: readonly unknown[] }): Promise<unknown> => {
        const value = chain[functionName];
        return typeof value === "function" ? value(...(args ?? [])) : value;
      },
    ),
    getBalance: vi.fn(async () => 10n ** 15n),
    waitForTransactionReceipt: vi.fn(async (): Promise<{ status: "success" | "reverted" }> => ({ status: "success" })),
  } satisfies ChainReader;
  const signer = {
    address: WALLET,
    sendTransaction: vi.fn(async () => TX_HASH),
    signMessage: vi.fn(async () => `0x${"cd".repeat(65)}` as Hex),
  } satisfies WalletSigner;
  const fetchMock = vi.fn<typeof fetch>();
  const client = new VibeKastClient({ reader, signer, fetch: fetchMock, sleep: async () => {} });
  return { chain, reader, signer, fetchMock, client };
}
