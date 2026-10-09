import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimWinningsAction,
  getMarketAction,
  getTestFundsAction,
  placeForecastAction,
  registerAgentAction,
  vibekastActions,
} from "../src/actions";
import { probsFromQuantiles } from "../src/distribution";
import { crowdQuantiles } from "../src/format";
import { parseForecast, parseRegistration, toForecast } from "../src/extract";
import { setClient } from "../src/settings";
import vibekastPlugin from "../src/index";
import { MARKET_RESPONSE, orderResponse, QUANTILES, reply, setup, TX_HASH } from "./fixtures";

const message = (text: string) => ({ content: { text } }) as unknown as Memory;

function runtime(settings: Record<string, string> = {}, modelReply = "") {
  return {
    character: { name: "Forecaster" },
    getSetting: (key: string) => settings[key] ?? null,
    useModel: vi.fn(async () => modelReply),
  } as unknown as IAgentRuntime & { useModel: ReturnType<typeof vi.fn> };
}

const forecastXml = (budget = "5") =>
  `<response>${QUANTILES.map((q, i) => `<p${[5, 10, 25, 50, 75, 90, 95][i]}>${q}</p${[5, 10, 25, 50, 75, 90, 95][i]}>`).join("")}<budget>${budget}</budget></response>`;

let t: ReturnType<typeof setup>;
beforeEach(() => {
  t = setup();
});

describe("plugin", () => {
  it("exposes six uniquely named actions with examples", () => {
    expect(vibekastPlugin.name).toBe("vibekast");
    const names = vibekastActions.map(a => a.name);
    expect(new Set(names).size).toBe(6);
    expect(names.every(n => n.startsWith("VIBEKAST_"))).toBe(true);
    expect(vibekastActions.every(a => a.examples?.length)).toBe(true);
  });

  it("offers trading actions only when a wallet key is set", async () => {
    const without = runtime();
    const withKey = runtime({ EVM_PRIVATE_KEY: "ab".repeat(32) });
    expect(await getMarketAction.validate(without, message(""))).toBe(true);
    expect(await placeForecastAction.validate(without, message(""))).toBe(false);
    expect(await placeForecastAction.validate(withKey, message(""))).toBe(true);
  });
});

describe("VIBEKAST_GET_MARKET", () => {
  it("summarises the crowd forecast", async () => {
    const rt = runtime();
    setClient(rt, t.client);
    t.fetchMock.mockResolvedValueOnce(reply(MARKET_RESPONSE));
    const callback = vi.fn(async (_content: { actions?: string[] }) => [] as Memory[]);
    const result = await getMarketAction.handler(rt, message("market?"), undefined, undefined, callback);
    expect(result).toMatchObject({ success: true });
    expect(callback.mock.calls[0][0]).toMatchObject({ actions: ["VIBEKAST_GET_MARKET"] });
    const text = (result as { text: string }).text;
    expect(text).toContain("Bitcoin is at $63,000.");
    expect(text).toContain("Most likely ranges: $62,000 to $64,000 (40%)");
  });

  it("reports API failures as a failed result instead of throwing", async () => {
    const rt = runtime();
    setClient(rt, t.client);
    t.fetchMock.mockResolvedValueOnce(reply({ error: "No live market" }, false, 503));
    const result = await getMarketAction.handler(rt, message("market?"));
    expect(result).toMatchObject({ success: false, text: "No live market" });
  });
});

describe("VIBEKAST_PLACE_FORECAST", () => {
  it("asks the model for a forecast on elizaOS 1.x and trades it", async () => {
    const rt = runtime({}, forecastXml("12"));
    setClient(rt, t.client);
    t.fetchMock
      .mockResolvedValueOnce(reply(MARKET_RESPONSE))
      .mockResolvedValueOnce(reply(MARKET_RESPONSE))
      .mockResolvedValueOnce(reply(orderResponse()))
      .mockResolvedValueOnce(reply(MARKET_RESPONSE));
    const state = { values: { recentMessages: "user: forecast BTC with 12 tUSDC" }, data: {}, text: "" } as State;
    const result = await placeForecastAction.handler(rt, message("forecast"), state);
    expect(rt.useModel).toHaveBeenCalledOnce();
    const prompt = (rt.useModel.mock.calls[0] as unknown as [string, { prompt: string }])[1].prompt;
    expect(prompt).toContain("user: forecast BTC with 12 tUSDC");
    expect(prompt).toContain("Latest BTC/USD: $63,000");
    expect(JSON.parse(String(t.fetchMock.mock.calls[2][1]?.body))).toMatchObject({
      probs: probsFromQuantiles(QUANTILES, MARKET_RESPONSE.edges),
      budget: 12,
    });
    expect(result).toMatchObject({ success: true });
    expect((result as { text: string }).text).toContain(TX_HASH);
  });

  it("uses planner parameters on elizaOS 2.x without calling the model", async () => {
    const rt = runtime();
    setClient(rt, t.client);
    t.fetchMock
      .mockResolvedValueOnce(reply(MARKET_RESPONSE))
      .mockResolvedValueOnce(reply(orderResponse()))
      .mockResolvedValueOnce(reply(MARKET_RESPONSE));
    const result = await placeForecastAction.handler(rt, message("forecast"), undefined, {
      parameters: { quantiles: QUANTILES, budget: 5 },
    });
    expect(rt.useModel).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: true });
  });

  it("refuses a closed market before asking the model", async () => {
    const rt = runtime({}, forecastXml());
    setClient(rt, t.client);
    t.fetchMock.mockResolvedValueOnce(reply({ ...MARKET_RESPONSE, open: false }));
    const result = await placeForecastAction.handler(rt, message("forecast"));
    expect(rt.useModel).not.toHaveBeenCalled();
    expect(result).toMatchObject({ success: false });
    expect((result as { text: string }).text).toContain("closed");
  });

  it("fails cleanly when the model reply is not a forecast", async () => {
    const rt = runtime({}, "I think it goes up!");
    setClient(rt, t.client);
    t.fetchMock.mockResolvedValueOnce(reply(MARKET_RESPONSE));
    const result = await placeForecastAction.handler(rt, message("forecast"));
    expect(result).toMatchObject({ success: false });
    expect(t.signer.sendTransaction).not.toHaveBeenCalled();
  });
});

describe("other actions", () => {
  it("funds the wallet", async () => {
    const rt = runtime();
    setClient(rt, t.client);
    t.reader.getBalance.mockResolvedValueOnce(0n).mockResolvedValue(10n ** 14n);
    t.chain.balanceOf = 0n;
    t.fetchMock.mockResolvedValueOnce(reply({ txHash: TX_HASH, amountEth: "0.0001" }));
    const result = await getTestFundsAction.handler(rt, message("fund me"));
    expect((result as { text: string }).text).toContain("Minted 10,000 test USDC");
  });

  it("says when there is nothing to claim", async () => {
    const rt = runtime();
    setClient(rt, t.client);
    const result = await claimWinningsAction.handler(rt, message("claim"));
    expect((result as { text: string }).text).toBe("Nothing to claim from settled markets.");
  });

  it("registers under the character name by default", async () => {
    const rt = runtime({}, "<response><name>null</name><url>null</url><description>null</description></response>");
    setClient(rt, t.client);
    t.fetchMock.mockResolvedValueOnce(reply({ ok: true }));
    const result = await registerAgentAction.handler(rt, message("sign me up"));
    expect(result).toMatchObject({ success: true });
    expect(JSON.parse(String(t.fetchMock.mock.calls[0][1]?.body)).name).toBe("Forecaster");
  });
});

describe("extraction", () => {
  it("parses, sorts and rounds a forecast", () => {
    expect(parseForecast(forecastXml())).toEqual({ quantiles: QUANTILES, budget: 5 });
    expect(toForecast(["65,000", "$61,000", 61500, 62500, 63000, 63500, 64500.4], null)).toEqual({
      quantiles: QUANTILES,
      budget: 5,
    });
  });

  it("rejects incomplete or repeated quantiles and clamps the budget", () => {
    expect(toForecast(QUANTILES.slice(1), 5)).toBeNull();
    expect(toForecast([1, 1, 2, 3, 4, 5, 6], 5)).toBeNull();
    expect(toForecast(QUANTILES, 50_000)?.budget).toBe(10_000);
  });

  it("drops non-https websites from a registration", () => {
    expect(
      parseRegistration("<name>Bot</name><url>http://x.y</url><description>Calibrated</description>", "Default"),
    ).toEqual({ name: "Bot", url: null, description: "Calibrated" });
  });

  it("reads crowd quantiles off the book", () => {
    const q = crowdQuantiles([60000, 62000, 64000, 66000, 68000], [0.1, 0.4, 0.3, 0.2]);
    expect(q[3]).toBeCloseTo(64000);
    expect(q[0]).toBeCloseTo(61000);
  });
});
