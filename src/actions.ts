import {
  ModelType,
  type Action,
  type ActionExample,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { VibeKastError } from "./client";
import { QUALIFYING_BUDGET, SITE_URL } from "./constants";
import {
  forecastPrompt,
  parseForecast,
  parseRegistration,
  registrationPrompt,
  toForecast,
  type ForecastParams,
  type RegistrationParams,
} from "./extract";
import { amount, closeLabel, closesIn, crowdQuantiles, ethAmount, rangeLabel, txUrl, usd } from "./format";
import { getClient, hasWallet } from "./settings";

const LEADERBOARD_URL = `${SITE_URL}/season`;

type Reply = { text: string; data?: Record<string, unknown> };

function errorText(error: unknown): string {
  if (error instanceof VibeKastError) return error.message;
  const short = (error as { shortMessage?: unknown })?.shortMessage;
  const detail = typeof short === "string" ? short : error instanceof Error ? error.message : String(error);
  return `Something went wrong talking to VibeKast: ${detail}`;
}

/** Runs an action body, reports the outcome through the callback and returns it as an ActionResult. */
async function respond(
  actionName: string,
  callback: HandlerCallback | undefined,
  body: () => Promise<Reply>,
): Promise<ActionResult> {
  try {
    const reply = await body();
    await callback?.({ text: reply.text, actions: [actionName] });
    return { success: true, text: reply.text, data: { actionName, ...reply.data } };
  } catch (error) {
    const text = errorText(error);
    await callback?.({ text, actions: [actionName], error: true });
    return { success: false, text, error: text, data: { actionName } };
  }
}

function conversation(message: Memory, state?: State): string {
  const recent = state?.values?.recentMessages;
  if (typeof recent === "string" && recent.trim() !== "") return recent;
  return message.content.text ?? "";
}

/** Planner-extracted parameters (elizaOS 2.x). Older runtimes don't pass them. */
function plannerParameters(options: unknown): Record<string, unknown> {
  const parameters = (options as { parameters?: unknown } | undefined)?.parameters;
  return parameters && typeof parameters === "object" ? (parameters as Record<string, unknown>) : {};
}

async function ask(runtime: IAgentRuntime, prompt: string): Promise<string> {
  const reply = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
  return typeof reply === "string" ? reply : String(reply ?? "");
}

const always = async () => true;
const walletConfigured = async (runtime: IAgentRuntime) => hasWallet(runtime);

const example = (user: string, agent: string, action: string): ActionExample[] => [
  { name: "{{userName}}", content: { text: user } },
  { name: "{{agentName}}", content: { text: agent, actions: [action] } },
];

export const getMarketAction: Action = {
  name: "VIBEKAST_GET_MARKET",
  similes: ["VIBEKAST_MARKET", "BTC_WEEKLY_FORECAST_MARKET", "VIBEKAST_CROWD_FORECAST"],
  description:
    "Read this week's VibeKast market: where the crowd thinks Bitcoin will close on Sunday 23:59 UTC, the latest BTC price, the close time and the fee. Use before placing a forecast.",
  validate: always,
  handler: async (runtime, _message, _state, _options, callback) =>
    respond("VIBEKAST_GET_MARKET", callback, async () => {
      const m = await getClient(runtime).getMarket();
      const crowd = crowdQuantiles(m.edges, m.prices);
      const likely = m.prices
        .map((p, i) => ({ p, range: rangeLabel(m.edges, i) }))
        .sort((a, b) => b.p - a.p)
        .slice(0, 3)
        .map(r => `${r.range} (${Math.round(r.p * 100)}%)`);
      const lines = [
        `This week's VibeKast market: ${m.question}`,
        m.open
          ? `Trading closes ${closeLabel(m.closeTimeIso)}, in ${closesIn(m.closeTimeIso)}.`
          : `Trading closed ${closeLabel(m.closeTimeIso)}. It settles shortly after.`,
        m.spot ? `Bitcoin is at ${usd(m.spot.price)}.` : null,
        `Crowd forecast: median ${usd(crowd[3])}, 90% between ${usd(crowd[0])} and ${usd(crowd[6])}.`,
        `Most likely ranges: ${likely.join(", ")}.`,
        `Fee: ${m.feeBps / 100}%. Trades use free test USDC on Base Sepolia.`,
      ];
      return {
        text: lines.filter(Boolean).join("\n"),
        data: { market: m.market, week: m.label, open: m.open, closesAt: m.closeTimeIso, spot: m.spot?.price ?? null, crowdQuantiles: crowd },
      };
    }),
  examples: [
    example(
      "Where does the crowd think Bitcoin closes this week?",
      "Let me check the VibeKast market.",
      "VIBEKAST_GET_MARKET",
    ),
  ],
};

export const getPositionAction: Action = {
  name: "VIBEKAST_GET_POSITION",
  similes: ["VIBEKAST_BALANCE", "VIBEKAST_PORTFOLIO", "VIBEKAST_MY_FORECAST"],
  description:
    "Show the agent wallet's VibeKast balances: Base Sepolia ETH for gas, test USDC, and the shares it holds in each Bitcoin price range this week.",
  validate: walletConfigured,
  handler: async (runtime, _message, _state, _options, callback) =>
    respond("VIBEKAST_GET_POSITION", callback, async () => {
      const p = await getClient(runtime).getPosition();
      const lines = [
        `Wallet ${p.wallet}: ${amount(p.tusdc)} tUSDC and ${ethAmount(p.eth)} Base Sepolia ETH.`,
        p.positions.length
          ? `Shares this week:\n${p.positions.map(x => `- ${x.range}: ${amount(x.shares)}`).join("\n")}\nEach share in the winning range pays 1 tUSDC after settlement.`
          : "No shares in this week's market yet.",
        p.needsGas || p.tusdc < QUALIFYING_BUDGET ? "Ask me to get test funds before forecasting." : null,
      ];
      return { text: lines.filter(Boolean).join("\n"), data: { wallet: p.wallet, tusdc: p.tusdc, eth: p.eth, positions: p.positions } };
    }),
  examples: [example("What's my VibeKast position?", "Checking the wallet.", "VIBEKAST_GET_POSITION")],
};

export const getTestFundsAction: Action = {
  name: "VIBEKAST_GET_TEST_FUNDS",
  similes: ["VIBEKAST_FAUCET", "VIBEKAST_MINT_TEST_USDC", "VIBEKAST_GET_GAS"],
  description:
    "Fund the agent wallet for VibeKast for free: Base Sepolia ETH for gas from the VibeKast faucet if it is nearly empty, and 10,000 test USDC if it is low. Use before the first forecast.",
  validate: walletConfigured,
  handler: async (runtime, _message, _state, _options, callback) =>
    respond("VIBEKAST_GET_TEST_FUNDS", callback, async () => {
      const r = await getClient(runtime).getTestFunds();
      const text = r.steps.map(s => (s.hash ? `${s.message} ${txUrl(s.hash)}` : s.message)).join("\n");
      return { text, data: { wallet: r.wallet, steps: r.steps } };
    }),
  examples: [
    example("Get some test money for VibeKast.", "Funding the wallet with test ETH and test USDC.", "VIBEKAST_GET_TEST_FUNDS"),
  ],
};

export const placeForecastAction: Action = {
  name: "VIBEKAST_PLACE_FORECAST",
  similes: ["VIBEKAST_FORECAST", "VIBEKAST_TRADE", "FORECAST_BITCOIN_CLOSE", "BET_ON_BTC_WEEKLY_CLOSE"],
  description: `Place a forecast of Bitcoin's weekly close on VibeKast by trading test USDC. The forecast is 7 BTC prices at the 5th, 10th, 25th, 50th, 75th, 90th and 95th percentiles; the agent forms its own if the user doesn't give one. Budget defaults to ${QUALIFYING_BUDGET} tUSDC, the minimum to count on the leaderboard.`,
  parameters: [
    {
      name: "quantiles",
      description: "BTC prices in USD at the 5th, 10th, 25th, 50th, 75th, 90th and 95th percentiles, lowest first.",
      required: false,
      schema: { type: "array", items: { type: "number" } },
    },
    {
      name: "budget",
      description: `Test USDC to spend, including fees. Defaults to ${QUALIFYING_BUDGET}.`,
      required: false,
      schema: { type: "number", minimum: 1, maximum: 10_000 },
    },
  ],
  validate: walletConfigured,
  handler: async (runtime, message, state, options, callback) =>
    respond("VIBEKAST_PLACE_FORECAST", callback, async () => {
      const client = getClient(runtime);
      const params = plannerParameters(options);
      let forecast: ForecastParams | null = Array.isArray(params.quantiles)
        ? toForecast(params.quantiles, params.budget)
        : null;
      if (!forecast) {
        const market = await client.getMarket();
        if (!market.open) throw new VibeKastError("This week's market has closed. The next one opens on Monday.");
        forecast = parseForecast(await ask(runtime, forecastPrompt(conversation(message, state), market)));
      }
      if (!forecast) throw new VibeKastError("I couldn't turn that into a forecast. Give 7 prices from the 5th to the 95th percentile.");

      const r = await client.placeForecast(forecast);
      const buy = r.transactions[r.transactions.length - 1];
      const lines = [
        `Placed my forecast for ${closeLabel(r.market.closeTimeIso)}.`,
        `Median ${usd(forecast.quantiles[3])}, 90% between ${usd(forecast.quantiles[0])} and ${usd(forecast.quantiles[6])}.`,
        `Spent ${amount(r.cost)} tUSDC including fees, across ${r.bought.length} price ranges.`,
        `Transaction: ${txUrl(buy.hash)}`,
        forecast.budget >= QUALIFYING_BUDGET ? `Leaderboard: ${LEADERBOARD_URL}` : null,
      ];
      return {
        text: lines.filter(Boolean).join("\n"),
        data: { quantiles: forecast.quantiles, budget: forecast.budget, cost: r.cost, bought: r.bought, transactions: r.transactions },
      };
    }),
  examples: [
    example(
      "Forecast this week's Bitcoin close on VibeKast.",
      "Placing my forecast on VibeKast.",
      "VIBEKAST_PLACE_FORECAST",
    ),
    example(
      "Put 20 tUSDC on BTC closing between 80k and 90k, median 85k.",
      "Placing that forecast with 20 tUSDC.",
      "VIBEKAST_PLACE_FORECAST",
    ),
  ],
};

export const claimWinningsAction: Action = {
  name: "VIBEKAST_CLAIM_WINNINGS",
  similes: ["VIBEKAST_REDEEM", "VIBEKAST_COLLECT_PAYOUT"],
  description:
    "Collect payouts from every settled VibeKast market: 1 tUSDC per share in the winning range, or a refund at final prices if a market was voided.",
  validate: walletConfigured,
  handler: async (runtime, _message, _state, _options, callback) =>
    respond("VIBEKAST_CLAIM_WINNINGS", callback, async () => {
      const r = await getClient(runtime).claimWinnings();
      const lines = r.claimed.length
        ? r.claimed.map(c => `${c.voided ? "Refunded from a voided market" : "Claimed winnings"}: ${txUrl(c.hash)}`)
        : ["Nothing to claim from settled markets."];
      if (r.pending) lines.push(`${r.pending} market${r.pending === 1 ? " has" : "s have"} not settled yet.`);
      return { text: lines.join("\n"), data: { claimed: r.claimed, pending: r.pending } };
    }),
  examples: [example("Claim my VibeKast winnings.", "Checking settled markets.", "VIBEKAST_CLAIM_WINNINGS")],
};

export const registerAgentAction: Action = {
  name: "VIBEKAST_REGISTER_AGENT",
  similes: ["VIBEKAST_JOIN_LEADERBOARD", "VIBEKAST_SIGN_UP"],
  description:
    "Register the agent wallet under a public name on the VibeKast leaderboard, where AI agents earn points next to human traders. Signs a message; no gas needed.",
  parameters: [
    { name: "name", description: "Public agent name, 3 to 32 characters.", required: false, schema: { type: "string", minLength: 3, maxLength: 32 } },
    { name: "url", description: "Optional https website.", required: false, schema: { type: "string" } },
    { name: "description", description: "Optional one-line description.", required: false, schema: { type: "string" } },
  ],
  validate: walletConfigured,
  handler: async (runtime, message, state, options, callback) =>
    respond("VIBEKAST_REGISTER_AGENT", callback, async () => {
      const defaultName = runtime.character?.name ?? "ElizaOS agent";
      const params = plannerParameters(options);
      const str = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
      const registration: RegistrationParams = str(params.name)
        ? { name: str(params.name)!, url: str(params.url), description: str(params.description) }
        : parseRegistration(await ask(runtime, registrationPrompt(conversation(message, state), defaultName)), defaultName);
      const r = await getClient(runtime).register(registration);
      return {
        text: `Registered as "${r.name}". Forecasts from this wallet now earn points on the VibeKast leaderboard with an AI tag: ${LEADERBOARD_URL}`,
        data: { name: r.name, wallet: r.wallet },
      };
    }),
  examples: [
    example("Sign up for the VibeKast leaderboard.", "Registering on VibeKast.", "VIBEKAST_REGISTER_AGENT"),
  ],
};

export const vibekastActions: Action[] = [
  getMarketAction,
  getPositionAction,
  getTestFundsAction,
  placeForecastAction,
  claimWinningsAction,
  registerAgentAction,
];
