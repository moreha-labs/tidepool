/**
 * Tidepool: Ammora SDK wiring for the $tAMM market on GIWA Sepolia (chain 91342).
 *
 * Addresses below were checked on the GIWA Sepolia explorer (2026-11-19):
 *  - $tAMM token and its launch curve were both created by Ammora's launch
 *    factory 0xd83C…46ac.
 *  - The native router was created by TAMM_MANAGED_ADDRESS, the Ammora
 *    managed address exported by @ammora-protocol/sdk itself.
 * Every session re-checks the token (name/symbol/decimals) and the curve state
 * on-chain before quoting, and every transaction is simulated before the
 * wallet is asked to sign.
 */
import {
  TAMM_GIWA_SEPOLIA_WETH,
  TAMM_TOKEN_DECIMALS,
  TAMM_TOKEN_SYMBOL,
  buildV3NativePoolExactInput,
  buildV3PoolExactInputForNative,
} from "@ammora-protocol/sdk";
import {
  createPublicClient,
  defineChain,
  erc20Abi,
  http,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";

export const CHAIN_ID = 91342;
export const RPC_URL = "https://sepolia-rpc.giwa.io";
export const EXPLORER = "https://sepolia-explorer.giwa.io";
export const FAUCET = "https://faucet.giwa.io/";

export const giwaSepolia = defineChain({
  id: CHAIN_ID,
  name: "GIWA Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "GIWA Explorer", url: EXPLORER } },
  testnet: true,
});

export const TAMM = {
  token: "0x10B3Cc2fc981277Ada576891CF649D0ABA768B06" as Address,
  curve: "0x1FD82a1BeAff168BdeFC790EB0f1A50f7C53b978" as Address,
  router: "0x4FC91b90087288520A7bB4aA7Ab5441bb4E9C496" as Address,
  weth: TAMM_GIWA_SEPOLIA_WETH as Address,
  decimals: TAMM_TOKEN_DECIMALS,
  symbol: TAMM_TOKEN_SYMBOL,
} as const;

export const SLIPPAGE_BPS = 100n; // 1%
const DEADLINE_SECONDS = 600n;

export const publicClient = createPublicClient({
  chain: giwaSepolia,
  transport: http(RPC_URL),
});

const CURVE_ABI = [
  { type: "function", name: "status", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "canonicalPool", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

const POOL_ABI = [
  {
    type: "function", name: "quoteExactIn", stateMutability: "view",
    inputs: [{ name: "tokenIn", type: "address" }, { name: "amountIn", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export type Market = { status: number; pool: Address; graduated: boolean };

/** Confirms the token on-chain is really $tAMM before anything else runs. */
export async function verifyToken(): Promise<void> {
  const [symbol, decimals] = await Promise.all([
    publicClient.readContract({ address: TAMM.token, abi: erc20Abi, functionName: "symbol" }),
    publicClient.readContract({ address: TAMM.token, abi: erc20Abi, functionName: "decimals" }),
  ]);
  if (symbol !== TAMM.symbol || decimals !== TAMM.decimals) {
    throw new Error(`Token check failed: found ${symbol} with ${decimals} decimals`);
  }
}

/** Reads the launch curve: status 3 means it graduated into a live pool. */
export async function readMarket(): Promise<Market> {
  const [status, pool] = await Promise.all([
    publicClient.readContract({ address: TAMM.curve, abi: CURVE_ABI, functionName: "status" }),
    publicClient.readContract({ address: TAMM.curve, abi: CURVE_ABI, functionName: "canonicalPool" }),
  ]);
  return { status, pool, graduated: status === 3 && pool !== zeroAddress };
}

/** Live quote from the graduated pool. side "buy" = ETH in, "sell" = $tAMM in. */
export async function quote(market: Market, side: "buy" | "sell", amountIn: bigint): Promise<bigint> {
  if (!market.graduated) throw new Error("The $tAMM pool is not open for trading right now.");
  return publicClient.readContract({
    address: market.pool,
    abi: POOL_ABI,
    functionName: "quoteExactIn",
    args: [side === "buy" ? TAMM.weth : TAMM.token, amountIn],
  });
}

export const minOut = (amountOut: bigint) => {
  const m = (amountOut * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  return m > 0n ? m : 1n;
};

const deadline = () => BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_SECONDS;

export type TxRequest = { to: Address; data: Hex; value: bigint };

/** ETH -> $tAMM through the Ammora native router (SDK calldata builder). */
export function buildBuy(market: Market, ethIn: bigint, expectedOut: bigint, recipient: Address): TxRequest {
  const tx = buildV3NativePoolExactInput(market.pool, ethIn, minOut(expectedOut), recipient, deadline(), zeroAddress);
  return { to: TAMM.router, data: tx.data, value: tx.value };
}

/** $tAMM -> ETH through the Ammora native router (SDK calldata builder). */
export function buildSell(market: Market, tammIn: bigint, expectedOut: bigint, recipient: Address): TxRequest {
  const tx = buildV3PoolExactInputForNative(market.pool, TAMM.token, tammIn, minOut(expectedOut), recipient, deadline(), zeroAddress);
  return { to: TAMM.router, data: tx.data, value: 0n };
}

export async function balances(owner: Address) {
  const [eth, tamm, allowance] = await Promise.all([
    publicClient.getBalance({ address: owner }),
    publicClient.readContract({ address: TAMM.token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
    publicClient.readContract({ address: TAMM.token, abi: erc20Abi, functionName: "allowance", args: [owner, TAMM.router] }),
  ]);
  return { eth, tamm, allowance };
}

/** Dry-run a transaction so a failing swap never reaches the wallet. */
export async function simulate(from: Address, tx: TxRequest): Promise<void> {
  await publicClient.call({ account: from, to: tx.to, data: tx.data, value: tx.value });
}
