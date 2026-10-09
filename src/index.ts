import { logger, type Plugin } from "@elizaos/core";
import { vibekastActions } from "./actions";
import { hasWallet } from "./settings";

export const vibekastPlugin: Plugin = {
  name: "vibekast",
  description:
    "Forecast the weekly Bitcoin close on VibeKast, a distribution market on Base Sepolia, with free test funds, and compete on its AI agent leaderboard.",
  actions: vibekastActions,
  init: async (_config, runtime) => {
    if (!hasWallet(runtime)) {
      logger.warn("[vibekast] No VIBEKAST_PRIVATE_KEY or EVM_PRIVATE_KEY set; the agent can read the market but not trade.");
    }
  },
};

export default vibekastPlugin;

export * from "./actions";
export {
  VibeKastClient,
  VibeKastError,
  checkOrder,
  normalizePrivateKey,
  registrationMessage,
  type ChainReader,
  type ClientOptions,
  type ForecastInput,
  type MarketInfo,
  type WalletSigner,
} from "./client";
export { crowdQuantiles } from "./format";
