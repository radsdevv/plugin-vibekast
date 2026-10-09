import { decodeFunctionData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it } from "vitest";
import { normalizePrivateKey, registrationMessage, VibeKastClient, VibeKastError } from "../src/client";
import { COLLATERAL_ABI, MARKET_ABI } from "../src/constants";
import { probsFromQuantiles } from "../src/distribution";
import {
  approveTx,
  buyTx,
  COLLATERAL,
  MARKET,
  MARKET_RESPONSE,
  OLD_MARKET,
  orderResponse,
  QUANTILES,
  reply,
  setup,
  STRANGER,
  TX_HASH,
  WAD,
  WALLET,
} from "./fixtures";

let t: ReturnType<typeof setup>;
beforeEach(() => {
  t = setup();
});

const lastBody = () => JSON.parse(String(t.fetchMock.mock.calls.at(-1)?.[1]?.body));

describe("settings", () => {
  it("accepts keys with or without 0x and rejects anything else", () => {
    const key = "ab".repeat(32);
    expect(normalizePrivateKey(key)).toBe(`0x${key}`);
    expect(normalizePrivateKey(`0x${key}`)).toBe(`0x${key}`);
    expect(normalizePrivateKey("")).toBeUndefined();
    expect(normalizePrivateKey(undefined)).toBeUndefined();
    expect(() => normalizePrivateKey("my-key-name")).toThrow(VibeKastError);
  });

  it("refuses wallet actions without a key", async () => {
    const client = new VibeKastClient({ reader: t.reader, fetch: t.fetchMock });
    expect(client.hasWallet).toBe(false);
    await expect(client.getPosition()).rejects.toThrow("No wallet is configured");
  });

  it("derives the signer from a private key", () => {
    const key = `0x${"11".repeat(32)}` as const;
    const client = new VibeKastClient({ privateKey: key, reader: t.reader, fetch: t.fetchMock });
    expect(client.address).toBe(privateKeyToAccount(key).address);
  });
});

describe("getPosition", () => {
  it("reads gas, test USDC and shares in the live market", async () => {
    t.fetchMock.mockResolvedValueOnce(reply(MARKET_RESPONSE));
    t.chain.balanceOfBatch = [0n, 3n * WAD, 0n, WAD / 2n];
    const p = await t.client.getPosition();
    expect(p.tusdc).toBe(10_000);
    expect(p.needsGas).toBe(false);
    expect(p.positions).toEqual([
      { index: 1, range: "$62,000 to $64,000", shares: 3 },
      { index: 3, range: "$66,000 and above", shares: 0.5 },
    ]);
  });
});

describe("getTestFunds", () => {
  it("requests gas and mints test USDC for an empty wallet", async () => {
    t.reader.getBalance.mockResolvedValueOnce(0n).mockResolvedValue(10n ** 14n);
    t.chain.balanceOf = 0n;
    t.fetchMock.mockResolvedValueOnce(reply({ txHash: TX_HASH, amountEth: "0.0001" }));
    const r = await t.client.getTestFunds();
    expect(lastBody()).toEqual({ wallet: WALLET });
    expect(r.steps.map(s => s.message)).toEqual([
      "Received 0.0001 Base Sepolia ETH for gas.",
      "Minted 10,000 test USDC (tUSDC).",
    ]);
    const [tx] = t.signer.sendTransaction.mock.calls[0] as unknown as [{ to: string; data: `0x${string}` }];
    expect(tx.to).toBe(COLLATERAL);
    expect(decodeFunctionData({ abi: COLLATERAL_ABI, data: tx.data }).functionName).toBe("faucet");
  });

  it("waits for a lagging RPC node to show the faucet ETH before minting", async () => {
    t.reader.getBalance
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(0n)
      .mockResolvedValueOnce(0n)
      .mockResolvedValue(10n ** 14n);
    t.chain.balanceOf = 0n;
    t.fetchMock.mockResolvedValueOnce(reply({ txHash: TX_HASH, amountEth: "0.0001" }));
    await t.client.getTestFunds();
    expect(t.reader.getBalance).toHaveBeenCalledTimes(4);
    expect(t.signer.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("does not mint if the faucet ETH never shows up", async () => {
    t.reader.getBalance.mockResolvedValue(0n);
    t.fetchMock.mockResolvedValueOnce(reply({ txHash: TX_HASH, amountEth: "0.0001" }));
    await expect(t.client.getTestFunds()).rejects.toThrow("did not show up");
    expect(t.signer.sendTransaction).not.toHaveBeenCalled();
  });

  it("does nothing when the wallet is already funded", async () => {
    const r = await t.client.getTestFunds();
    expect(t.fetchMock).not.toHaveBeenCalled();
    expect(t.signer.sendTransaction).not.toHaveBeenCalled();
    expect(r.steps.every(s => !s.hash)).toBe(true);
  });

  it("keeps existing gas when the faucet refuses a wallet that can still pay", async () => {
    t.reader.getBalance.mockResolvedValue(5n * 10n ** 13n);
    t.fetchMock.mockResolvedValueOnce(reply({ error: "Already claimed today" }, false, 429));
    const r = await t.client.getTestFunds();
    expect(r.steps[0].message).toMatch(/^Kept the/);
  });

  it("reports the faucet error when the wallet cannot pay gas", async () => {
    t.reader.getBalance.mockResolvedValue(0n);
    t.fetchMock.mockResolvedValueOnce(reply({ error: "Already claimed today" }, false, 429));
    await expect(t.client.getTestFunds()).rejects.toThrow("Already claimed today");
  });
});

describe("placeForecast", () => {
  it("builds the order from quantiles, checks it and sends approve then buy", async () => {
    t.fetchMock.mockResolvedValueOnce(reply(MARKET_RESPONSE)).mockResolvedValueOnce(reply(orderResponse())).mockResolvedValueOnce(reply(MARKET_RESPONSE));
    const r = await t.client.placeForecast({ quantiles: QUANTILES, budget: 5 });
    const body = JSON.parse(String(t.fetchMock.mock.calls[1][1]?.body));
    expect(body).toEqual({ probs: probsFromQuantiles(QUANTILES, MARKET_RESPONSE.edges), budget: 5, slippageBps: 100, wallet: WALLET });
    expect(body.quantiles).toBeUndefined();
    expect(t.signer.sendTransaction).toHaveBeenCalledTimes(2);
    expect(r.cost).toBe(4.949);
    expect(r.bought.map(b => b.range)).toEqual(["$62,000 to $64,000", "$64,000 to $66,000"]);
  });

  it.each([
    ["no forecast", {}],
    ["both forms", { quantiles: QUANTILES, probs: [0.25, 0.25, 0.25, 0.25] }],
    ["the wrong number of quantiles", { quantiles: QUANTILES.slice(1) }],
  ])("rejects %s", async (_label, forecast) => {
    await expect(t.client.placeForecast({ ...forecast, budget: 5 })).rejects.toThrow(VibeKastError);
    expect(t.fetchMock).not.toHaveBeenCalled();
  });

  it("treats empty arrays as not given", async () => {
    t.fetchMock.mockResolvedValueOnce(reply(MARKET_RESPONSE)).mockResolvedValueOnce(reply(orderResponse())).mockResolvedValueOnce(reply(MARKET_RESPONSE));
    await t.client.placeForecast({ quantiles: QUANTILES, probs: [], budget: 5 });
    expect(JSON.parse(String(t.fetchMock.mock.calls[1][1]?.body)).probs).toHaveLength(MARKET_RESPONSE.n);
  });

  it("rejects budgets out of range", async () => {
    await expect(t.client.placeForecast({ quantiles: QUANTILES, budget: 0.5 })).rejects.toThrow("between 1");
  });

  it.each([
    ["an order for another market", { ...orderResponse(), market: OLD_MARKET }],
    ["an approval to another spender", orderResponse([approveTx(STRANGER), buyTx()])],
    ["an approval over budget", orderResponse([approveTx(MARKET, 6n * WAD), buyTx()])],
    ["a buy over budget", orderResponse([approveTx(), buyTx(6n * WAD)])],
    ["a maxCost over budget", orderResponse(undefined, 6n * WAD)],
    ["an unknown contract", orderResponse([{ ...approveTx(), to: STRANGER }, buyTx()])],
    ["sending ETH", orderResponse([approveTx(), { ...buyTx(), value: "1" }])],
    ["no buy", orderResponse([approveTx()])],
    ["two buys", orderResponse([buyTx(), buyTx()])],
    ["a buy before the approval", orderResponse([buyTx(), approveTx()])],
    [
      "another call to the token",
      orderResponse([
        {
          ...approveTx(),
          data: decodeAndReencodeTransfer(),
        },
        buyTx(),
      ]),
    ],
  ])("refuses %s without sending anything", async (_label, order) => {
    t.fetchMock.mockResolvedValueOnce(reply(MARKET_RESPONSE)).mockResolvedValueOnce(reply(order));
    await expect(t.client.placeForecast({ quantiles: QUANTILES, budget: 5 })).rejects.toThrow(/^Refused the order/);
    expect(t.signer.sendTransaction).not.toHaveBeenCalled();
  });

  it("allows up to budget plus slippage", async () => {
    const cap = (5n * WAD * 10_100n) / 10_000n;
    t.fetchMock
      .mockResolvedValueOnce(reply(MARKET_RESPONSE))
      .mockResolvedValueOnce(reply(orderResponse([approveTx(MARKET, cap), buyTx(cap)], cap)))
      .mockResolvedValueOnce(reply(MARKET_RESPONSE));
    await t.client.placeForecast({ quantiles: QUANTILES, budget: 5 });
    expect(t.signer.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it("stops when the wallet lacks test USDC", async () => {
    t.chain.balanceOf = WAD;
    t.fetchMock.mockResolvedValueOnce(reply(MARKET_RESPONSE)).mockResolvedValueOnce(reply(orderResponse()));
    await expect(t.client.placeForecast({ quantiles: QUANTILES, budget: 5 })).rejects.toThrow("Get test funds first");
    expect(t.signer.sendTransaction).not.toHaveBeenCalled();
  });

  it("waits for a lagging RPC node to show the approval before buying", async () => {
    let reads = 0;
    t.chain.allowance = () => (++reads < 3 ? 0n : 10_000n * WAD);
    t.fetchMock.mockResolvedValueOnce(reply(MARKET_RESPONSE)).mockResolvedValueOnce(reply(orderResponse())).mockResolvedValueOnce(reply(MARKET_RESPONSE));
    await t.client.placeForecast({ quantiles: QUANTILES, budget: 5 });
    expect(reads).toBe(3);
    expect(t.signer.sendTransaction).toHaveBeenCalledTimes(2);
  });

  it("gives up if the approval never shows up", async () => {
    t.chain.allowance = 0n;
    t.fetchMock.mockResolvedValueOnce(reply(MARKET_RESPONSE)).mockResolvedValueOnce(reply(orderResponse()));
    await expect(t.client.placeForecast({ quantiles: QUANTILES, budget: 5 })).rejects.toThrow("did not show up");
    expect(t.signer.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("stops after a reverted transaction", async () => {
    t.reader.waitForTransactionReceipt.mockResolvedValueOnce({ status: "reverted" });
    t.fetchMock.mockResolvedValueOnce(reply(MARKET_RESPONSE)).mockResolvedValueOnce(reply(orderResponse()));
    await expect(t.client.placeForecast({ quantiles: QUANTILES, budget: 5 })).rejects.toThrow("reverted");
    expect(t.signer.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("surfaces API errors", async () => {
    t.fetchMock.mockResolvedValueOnce(reply(MARKET_RESPONSE)).mockResolvedValueOnce(reply({ error: "Market is closed" }, false, 409));
    await expect(t.client.placeForecast({ quantiles: QUANTILES, budget: 5 })).rejects.toThrow("Market is closed");
  });
});

describe("claimWinnings", () => {
  it("claims settled markets with a winning position and skips the rest", async () => {
    const resolved: Record<string, boolean> = { [OLD_MARKET]: true, [MARKET]: false };
    t.reader.readContract.mockImplementation(async ({ address, functionName, args }) => {
      if (functionName === "resolved") return resolved[address];
      if (functionName === "balanceOfBatch") return [0n, 2n * WAD, 0n, 0n];
      const value = t.chain[functionName];
      return typeof value === "function" ? value(...(args ?? [])) : value;
    });
    const r = await t.client.claimWinnings();
    expect(r.claimed).toEqual([{ market: OLD_MARKET, voided: false, hash: TX_HASH }]);
    expect(r.pending).toBe(1);
    const [tx] = t.signer.sendTransaction.mock.calls[0] as unknown as [{ to: string; data: `0x${string}` }];
    expect(tx.to).toBe(OLD_MARKET);
    expect(decodeFunctionData({ abi: MARKET_ABI, data: tx.data }).functionName).toBe("redeem");
  });

  it("refunds voided markets", async () => {
    t.chain.voided = true;
    t.chain.balanceOfBatch = [WAD, 0n, 0n, 0n];
    const r = await t.client.claimWinnings();
    expect(r.claimed.map(c => c.voided)).toEqual([true, true]);
    const [tx] = t.signer.sendTransaction.mock.calls[0] as unknown as [{ data: `0x${string}` }];
    expect(decodeFunctionData({ abi: MARKET_ABI, data: tx.data }).functionName).toBe("redeemVoided");
  });

  it("sends nothing when only losing ranges are held", async () => {
    t.chain.resolved = true;
    t.chain.balanceOfBatch = [WAD, 0n, 0n, 0n];
    const r = await t.client.claimWinnings();
    expect(r.claimed).toEqual([]);
    expect(t.signer.sendTransaction).not.toHaveBeenCalled();
  });
});

describe("register", () => {
  it("signs the canonical message and posts it", async () => {
    t.fetchMock.mockResolvedValueOnce(reply({ ok: true }));
    await t.client.register({ name: " Eliza Forecaster ", url: "", description: null });
    const body = lastBody();
    expect(body).toMatchObject({ name: "Eliza Forecaster", wallet: WALLET.toLowerCase(), url: null, description: null });
    expect(t.signer.signMessage).toHaveBeenCalledWith(
      registrationMessage({ name: "Eliza Forecaster", wallet: WALLET, url: null, description: null, issuedAt: body.issuedAt }),
    );
  });

  it("matches the message format the server verifies", () => {
    expect(
      registrationMessage({ name: "A", wallet: "0xABC", url: null, description: "x", issuedAt: "2026-10-09T00:00:00.000Z" }),
    ).toBe(
      "VibeKast Agent League registration\nAgent: A\nWallet: 0xabc\nWebsite: none\nAbout: x\nChain ID: 84532\nIssued at: 2026-10-09T00:00:00.000Z",
    );
  });
});

function decodeAndReencodeTransfer(): `0x${string}` {
  // transfer(address,uint256) selector with arguments; not in the collateral ABI the client accepts.
  return `0xa9059cbb${MARKET.slice(2).padStart(64, "0")}${(5n * WAD).toString(16).padStart(64, "0")}`;
}
