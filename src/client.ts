import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  encodeFunctionData,
  formatUnits,
  http,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import {
  ALLOWANCE_POLL,
  COLLATERAL_ABI,
  DEFAULT_API_URL,
  DEFAULT_RPC_URL,
  FAUCET_THRESHOLD_WEI,
  MARKET_ABI,
  MIN_GAS_WEI,
  MIN_TUSDC,
  ORDER_LIMITS,
  QUANTILE_LEVELS,
  REGISTRY_ABI,
  REGISTRY_ADDRESS,
} from "./constants";
import { probsFromQuantiles } from "./distribution";
import { ethAmount, rangeLabel, round, sameAddress, units } from "./format";

export interface MarketInfo {
  market: Hex;
  collateral: Hex;
  label: string;
  question: string;
  closeTimeIso: string;
  open: boolean;
  n: number;
  edges: number[];
  prices: number[];
  feeBps: number;
  spot?: { price: number; updatedAt: number };
  settlement: string;
}

interface OrderResponse {
  market: Hex;
  shares: string[];
  quote: { cost: number; fee: number; total: number };
  maxCost: { units: number; wad: string };
  transactions: { to: Hex; data: Hex; value: string; description: string }[];
}

export interface SentTx {
  description: string;
  hash: Hex;
}

/** Reads the chain. Satisfied by a viem public client. */
export interface ChainReader {
  readContract(args: {
    address: Hex;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  }): Promise<unknown>;
  getBalance(args: { address: Hex }): Promise<bigint>;
  waitForTransactionReceipt(args: { hash: Hex }): Promise<{ status: "success" | "reverted" }>;
}

/** Signs and sends for one wallet. The key never leaves it. */
export interface WalletSigner {
  address: Hex;
  sendTransaction(tx: { to: Hex; data: Hex }): Promise<Hex>;
  signMessage(message: string): Promise<Hex>;
}

/** A failure with a message that is safe and useful to show the user. */
export class VibeKastError extends Error {}

export interface ForecastInput {
  quantiles?: number[];
  probs?: number[];
  budget: number;
  slippageBps?: number;
}

export interface ClientOptions {
  apiUrl?: string;
  rpcUrl?: string;
  privateKey?: Hex;
  reader?: ChainReader;
  signer?: WalletSigner;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function normalizePrivateKey(raw: unknown): Hex | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const key = raw.trim().startsWith("0x") ? raw.trim() : `0x${raw.trim()}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new VibeKastError("The VibeKast private key must be 32 bytes of hex (64 characters).");
  }
  return key as Hex;
}

/** The exact message a wallet signs (EIP-191) to register on the VibeKast agent leaderboard. */
export function registrationMessage(f: {
  name: string;
  wallet: string;
  url: string | null;
  description: string | null;
  issuedAt: string;
}): string {
  return [
    "VibeKast Agent League registration",
    `Agent: ${f.name}`,
    `Wallet: ${f.wallet.toLowerCase()}`,
    `Website: ${f.url ?? "none"}`,
    `About: ${f.description ?? "none"}`,
    "Chain ID: 84532",
    `Issued at: ${f.issuedAt}`,
  ].join("\n");
}

/**
 * Talks to VibeKast: the public agent API for market data and order building,
 * and Base Sepolia directly for every safety check and transaction.
 */
export class VibeKastClient {
  readonly apiUrl: string;
  private readonly reader: ChainReader;
  private readonly signer?: WalletSigner;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: ClientOptions = {}) {
    this.apiUrl = (options.apiUrl || DEFAULT_API_URL).replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const transport = http(options.rpcUrl || DEFAULT_RPC_URL);
    this.reader =
      options.reader ??
      (createPublicClient({ chain: baseSepolia, transport }) as unknown as ChainReader);
    if (options.signer) {
      this.signer = options.signer;
    } else if (options.privateKey) {
      const account = privateKeyToAccount(options.privateKey);
      const wallet = createWalletClient({ account, chain: baseSepolia, transport });
      this.signer = {
        address: account.address,
        sendTransaction: tx => wallet.sendTransaction({ to: tx.to, data: tx.data }),
        signMessage: message => account.signMessage({ message }),
      };
    }
  }

  get hasWallet(): boolean {
    return this.signer !== undefined;
  }

  get address(): Hex {
    return this.wallet().address;
  }

  getMarket(): Promise<MarketInfo> {
    return this.api<MarketInfo>("/market");
  }

  async getPosition() {
    const wallet = this.address;
    const m = await this.getMarket();
    const [eth, tusdc, shares] = await Promise.all([
      this.reader.getBalance({ address: wallet }),
      this.read<bigint>(m.collateral, COLLATERAL_ABI, "balanceOf", [wallet]),
      this.balances(m.market, m.n, wallet),
    ]);
    return {
      wallet,
      market: m,
      eth: formatUnits(eth, 18),
      tusdc: units(tusdc),
      needsGas: eth < MIN_GAS_WEI,
      positions: shares
        .map((s, i) => ({ index: i, range: rangeLabel(m.edges, i), shares: round(units(s)) }))
        .filter(p => p.shares > 0),
    };
  }

  /** Tops up gas from the VibeKast faucet and mints test USDC, each only when needed. */
  async getTestFunds() {
    const wallet = this.address;
    const steps: { step: "eth" | "tusdc"; message: string; hash?: Hex }[] = [];

    const eth = await this.reader.getBalance({ address: wallet });
    if (eth < FAUCET_THRESHOLD_WEI) {
      try {
        const res = await this.api<{ txHash: Hex; amountEth: string }>("/faucet", { wallet });
        await this.confirm(res.txHash, "test ETH from the faucet");
        await this.waitForBalanceAbove(wallet, eth);
        steps.push({ step: "eth", message: `Received ${res.amountEth} Base Sepolia ETH for gas.`, hash: res.txHash });
      } catch (error) {
        if (eth < MIN_GAS_WEI) throw error;
        steps.push({ step: "eth", message: `Kept the ${ethAmount(eth)} ETH already in the wallet for gas.` });
      }
    } else {
      steps.push({ step: "eth", message: `The wallet already has ${ethAmount(eth)} ETH for gas.` });
    }

    const { collateral } = await this.liveMarket();
    const balance = units(await this.read<bigint>(collateral, COLLATERAL_ABI, "balanceOf", [wallet]));
    if (balance < MIN_TUSDC) {
      const hash = await this.send(
        { to: collateral, data: encodeFunctionData({ abi: COLLATERAL_ABI, functionName: "faucet" }) },
        "mint test USDC",
      );
      steps.push({ step: "tusdc", message: "Minted 10,000 test USDC (tUSDC).", hash });
    } else {
      steps.push({ step: "tusdc", message: `The wallet already has ${round(balance).toLocaleString("en-US")} tUSDC.` });
    }
    return { wallet, steps };
  }

  /** Turns a forecast into a trade on the live market, checks it against the chain and sends it. */
  async placeForecast(input: ForecastInput) {
    const quantiles = input.quantiles?.length ? input.quantiles : undefined;
    const probs = input.probs?.length ? input.probs : undefined;
    if ((quantiles === undefined) === (probs === undefined)) {
      throw new VibeKastError("Give a forecast as either 7 quantiles or one probability per range.");
    }
    if (quantiles && quantiles.length !== QUANTILE_LEVELS.length) {
      throw new VibeKastError(`A forecast needs exactly ${QUANTILE_LEVELS.length} prices, at the ${QUANTILE_LEVELS.join(", ")}th percentiles.`);
    }
    if (!(input.budget >= ORDER_LIMITS.minBudget && input.budget <= ORDER_LIMITS.maxBudget)) {
      throw new VibeKastError(`The budget must be between ${ORDER_LIMITS.minBudget} and ${ORDER_LIMITS.maxBudget.toLocaleString("en-US")} tUSDC.`);
    }
    const slippageBps = input.slippageBps ?? ORDER_LIMITS.defaultSlippageBps;
    const wallet = this.address;
    const { market, collateral } = await this.liveMarket();

    let rangeProbs = probs;
    if (quantiles) {
      const m = await this.getMarket();
      if (!sameAddress(m.market, market)) {
        throw new VibeKastError("The VibeKast API and the chain disagree on this week's market. Try again shortly.");
      }
      if (quantiles.some(q => !Number.isFinite(q))) throw new VibeKastError("Every forecast price must be a number.");
      rangeProbs = probsFromQuantiles(quantiles, m.edges);
    }

    const order = await this.api<OrderResponse>("/order", {
      probs: rangeProbs,
      budget: input.budget,
      slippageBps,
      wallet,
    });
    const spendCap = (BigInt(Math.ceil(input.budget * 1e6)) * 10n ** 12n * BigInt(10_000 + slippageBps)) / 10_000n;
    checkOrder(order, market, collateral, spendCap);

    const balance = await this.read<bigint>(collateral, COLLATERAL_ABI, "balanceOf", [wallet]);
    if (balance < BigInt(order.maxCost.wad)) {
      throw new VibeKastError(
        `The wallet has ${round(units(balance))} tUSDC but this forecast needs up to ${round(order.maxCost.units)}. Get test funds first.`,
      );
    }

    const sent: SentTx[] = [];
    for (const tx of order.transactions) {
      const hash = await this.send({ to: tx.to, data: tx.data }, tx.description);
      sent.push({ description: tx.description, hash });
      if (sameAddress(tx.to, collateral)) await this.waitForAllowance(collateral, market, tx.data);
    }

    const m = await this.getMarket();
    return {
      market: m,
      cost: order.quote.total,
      fee: order.quote.fee,
      transactions: sent,
      bought: order.shares
        .map((s, i) => ({ index: i, range: rangeLabel(m.edges, i), shares: round(units(BigInt(s))) }))
        .filter(b => b.shares > 0),
    };
  }

  /** Claims every settled VibeKast market where the wallet has something to collect. */
  async claimWinnings() {
    const wallet = this.address;
    const count = await this.read<bigint>(REGISTRY_ADDRESS, REGISTRY_ABI, "count");
    const claimed: { market: Hex; voided: boolean; hash: Hex }[] = [];
    let pending = 0;
    for (let i = count - 1n; i >= 0n; i--) {
      const market = await this.read<Hex>(REGISTRY_ADDRESS, REGISTRY_ABI, "marketAt", [i]);
      const [resolved, voided, n] = await Promise.all([
        this.read<boolean>(market, MARKET_ABI, "resolved"),
        this.read<boolean>(market, MARKET_ABI, "voided"),
        this.read<bigint>(market, MARKET_ABI, "n"),
      ]);
      const shares = await this.balances(market, Number(n), wallet);
      if (!resolved && !voided) {
        if (shares.some(s => s > 0n)) pending++;
        continue;
      }
      const claimable = voided
        ? shares.some(s => s > 0n)
        : shares[Number(await this.read<bigint>(market, MARKET_ABI, "winningBucket"))] > 0n;
      if (!claimable) continue;
      const hash = await this.send(
        {
          to: market,
          data: encodeFunctionData({ abi: MARKET_ABI, functionName: voided ? "redeemVoided" : "redeem" }),
        },
        voided ? "refund from a voided market" : "claim winnings",
      );
      claimed.push({ market, voided, hash });
    }
    return { claimed, pending };
  }

  /** Registers the wallet as a named AI agent by signing a message. No gas needed. */
  async register(input: { name: string; url?: string | null; description?: string | null }) {
    const name = input.name.trim();
    const url = input.url?.trim() || null;
    const description = input.description?.trim() || null;
    const wallet = this.address.toLowerCase();
    const issuedAt = new Date().toISOString();
    const signature = await this.wallet().signMessage(
      registrationMessage({ name, wallet, url, description, issuedAt }),
    );
    await this.api("/register", { name, wallet, url, description, issuedAt, signature });
    return { name, wallet };
  }

  private wallet(): WalletSigner {
    if (!this.signer) {
      throw new VibeKastError("No wallet is configured. Set VIBEKAST_PRIVATE_KEY (or EVM_PRIVATE_KEY) to trade.");
    }
    return this.signer;
  }

  private async api<T>(path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new VibeKastError(json.error ?? `The VibeKast API returned ${res.status}.`);
    return json as T;
  }

  private read<T>(address: Hex, abi: readonly unknown[], functionName: string, args?: readonly unknown[]): Promise<T> {
    return this.reader.readContract({ address, abi, functionName, args }) as Promise<T>;
  }

  private balances(market: Hex, n: number, wallet: Hex): Promise<readonly bigint[]> {
    return this.read<readonly bigint[]>(market, MARKET_ABI, "balanceOfBatch", [
      Array(n).fill(wallet),
      Array.from({ length: n }, (_, i) => BigInt(i)),
    ]);
  }

  /** The live market and its collateral, read from the on-chain registry rather than the API. */
  private async liveMarket(): Promise<{ market: Hex; collateral: Hex }> {
    const market = await this.read<Hex>(REGISTRY_ADDRESS, REGISTRY_ABI, "latest");
    const collateral = await this.read<Hex>(market, MARKET_ABI, "collateral");
    return { market, collateral };
  }

  private async send(tx: { to: Hex; data: Hex }, description: string): Promise<Hex> {
    const hash = await this.wallet().sendTransaction(tx);
    await this.confirm(hash, description);
    return hash;
  }

  private async confirm(hash: Hex, description: string): Promise<void> {
    const receipt = await this.reader.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new VibeKastError(`The ${description} transaction ${hash} reverted.`);
    }
  }

  /** Load-balanced RPCs can lag behind a receipt; minting right after the faucet would then fail gas estimation. */
  private async waitForBalanceAbove(wallet: Hex, previous: bigint): Promise<void> {
    for (let attempt = 0; attempt < ALLOWANCE_POLL.attempts; attempt++) {
      if ((await this.reader.getBalance({ address: wallet })) > previous) return;
      await this.sleep(ALLOWANCE_POLL.intervalMs);
    }
    throw new VibeKastError("The test ETH arrived but did not show up on the RPC node in time. Try again in a minute.");
  }

  /** Load-balanced RPCs can lag a block behind a receipt; the buy would then fail gas estimation. */
  private async waitForAllowance(collateral: Hex, market: Hex, approveData: Hex): Promise<void> {
    const [, needed] = decodeFunctionData({ abi: COLLATERAL_ABI, data: approveData }).args as [Hex, bigint];
    for (let attempt = 0; attempt < ALLOWANCE_POLL.attempts; attempt++) {
      const allowance = await this.read<bigint>(collateral, COLLATERAL_ABI, "allowance", [this.address, market]);
      if (allowance >= needed) return;
      await this.sleep(ALLOWANCE_POLL.intervalMs);
    }
    throw new VibeKastError("The approval did not show up on the RPC node in time. Try again.");
  }
}

/**
 * Refuses any transaction from the API that is not an approval of the live
 * market or a single final buy on it, or that could spend more than the budget
 * plus slippage.
 */
export function checkOrder(order: OrderResponse, market: Hex, collateral: Hex, spendCap: bigint): void {
  const refuse = (reason: string): never => {
    throw new VibeKastError(`Refused the order from the VibeKast API: ${reason}.`);
  };
  const decode = <A extends typeof COLLATERAL_ABI | typeof MARKET_ABI>(abi: A, data: Hex, target: string) => {
    try {
      return decodeFunctionData({ abi, data });
    } catch {
      return refuse(`unexpected call to the ${target}`);
    }
  };
  if (!sameAddress(order.market, market)) refuse("it is for a different market");
  if (BigInt(order.maxCost.wad) > spendCap) refuse("it would spend more than the budget");
  const buys = order.transactions.filter(tx => sameAddress(tx.to, market));
  if (buys.length !== 1 || order.transactions[order.transactions.length - 1] !== buys[0]) {
    refuse("it must end with exactly one buy");
  }
  for (const tx of order.transactions) {
    if (BigInt(tx.value || "0") !== 0n) refuse("it sends ETH");
    if (sameAddress(tx.to, collateral)) {
      const call = decode(COLLATERAL_ABI, tx.data, "test USDC token");
      if (call.functionName !== "approve") refuse("unexpected call to the test USDC token");
      const [spender, value] = call.args as [Hex, bigint];
      if (!sameAddress(spender, market) || value > spendCap) refuse("unexpected approval");
    } else if (sameAddress(tx.to, market)) {
      const call = decode(MARKET_ABI, tx.data, "market");
      if (call.functionName !== "buy") refuse("unexpected call to the market");
      const [, maxCost] = call.args as [readonly bigint[], bigint];
      if (maxCost > spendCap) refuse("the trade would spend more than the budget");
    } else {
      refuse(`it sends to an unknown contract ${tx.to}`);
    }
  }
}
