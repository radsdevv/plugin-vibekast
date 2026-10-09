import { parseAbi } from "viem";

/** Public VibeKast agent API. It reads the market and builds unsigned transactions; it never holds keys. */
export const DEFAULT_API_URL = "https://www.vibekast.xyz/api/agents/v1";

export const DEFAULT_RPC_URL = "https://sepolia.base.org";

export const SITE_URL = "https://www.vibekast.xyz";

export const EXPLORER_TX_URL = "https://sepolia.basescan.org/tx/";

/** On-chain MarketRegistry on Base Sepolia. `latest()` is the market trading now. */
export const REGISTRY_ADDRESS = "0x7C1E4bdA9a5Bd57236336Bae96966918F5eC99FC";

export const CHAIN_ID = 84532;

/** Test USDC and outcome shares both use 18 decimals. */
export const DECIMALS = 18;

/** The test ETH faucet only serves wallets holding less than this (0.0001 ETH). */
export const FAUCET_THRESHOLD_WEI = 100_000_000_000_000n;

/** Below this (0.00001 ETH, a few trades) the wallet should top up gas. */
export const MIN_GAS_WEI = 10_000_000_000_000n;

/** Mint more test USDC when the wallet holds less than this. */
export const MIN_TUSDC = 100;

export const ORDER_LIMITS = {
  minBudget: 1,
  maxBudget: 10_000,
  defaultBudget: 5,
  defaultSlippageBps: 100,
} as const;

/** Spend at least this much for a forecast to count on the leaderboard. */
export const QUALIFYING_BUDGET = 5;

/** How long to wait for a mined approval to show up on a lagging RPC node. */
export const ALLOWANCE_POLL = { attempts: 15, intervalMs: 1_000 } as const;

export const QUANTILE_LEVELS = [5, 10, 25, 50, 75, 90, 95] as const;

export const SETTINGS = {
  privateKey: "VIBEKAST_PRIVATE_KEY",
  fallbackPrivateKey: "EVM_PRIVATE_KEY",
  rpcUrl: "VIBEKAST_RPC_URL",
  apiUrl: "VIBEKAST_API_URL",
} as const;

export const REGISTRY_ABI = parseAbi([
  "function latest() view returns (address)",
  "function count() view returns (uint256)",
  "function marketAt(uint256 i) view returns (address)",
]);

export const MARKET_ABI = parseAbi([
  "function n() view returns (uint256)",
  "function collateral() view returns (address)",
  "function resolved() view returns (bool)",
  "function voided() view returns (bool)",
  "function winningBucket() view returns (uint256)",
  "function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])",
  "function buy(uint256[] shares, uint256 maxCost)",
  "function redeem() returns (uint256 payout)",
  "function redeemVoided() returns (uint256 payout)",
]);

export const COLLATERAL_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function faucet()",
]);
