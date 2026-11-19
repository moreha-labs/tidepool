import "./style.css";
import {
  createWalletClient,
  custom,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
  type WalletClient,
} from "viem";
import {
  CHAIN_ID,
  EXPLORER,
  FAUCET,
  RPC_URL,
  TAMM,
  balances,
  buildBuy,
  buildSell,
  giwaSepolia,
  publicClient,
  quote,
  readMarket,
  simulate,
  verifyToken,
  type Market,
} from "./ammora";

type Eip1193 = {
  request: (a: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (e: string, h: (...a: unknown[]) => void) => void;
};
declare global { interface Window { ethereum?: Eip1193 } }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const state = {
  side: "buy" as "buy" | "sell",
  market: null as Market | null,
  account: null as Address | null,
  wallet: null as WalletClient | null,
  bal: null as Awaited<ReturnType<typeof balances>> | null,
  quoteOut: null as bigint | null,
  busy: false,
};

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const fmt = (v: bigint, d: number, max = 6) => {
  const n = Number(formatUnits(v, d));
  return n.toLocaleString("en-US", { maximumFractionDigits: max });
};
const inDecimals = () => (state.side === "buy" ? 18 : TAMM.decimals);
const outDecimals = () => (state.side === "buy" ? TAMM.decimals : 18);
const inSymbol = () => (state.side === "buy" ? "ETH" : "$tAMM");
const outSymbol = () => (state.side === "buy" ? "$tAMM" : "ETH");

function setStatus(msg: string, kind: "info" | "ok" | "err" = "info", tx?: string) {
  const el = $("status");
  el.className = `status ${kind}`;
  el.innerHTML = msg + (tx ? ` <a href="${EXPLORER}/tx/${tx}" target="_blank" rel="noreferrer">View on explorer ↗</a>` : "");
}

function parseAmount(): bigint | null {
  const raw = $<HTMLInputElement>("amount").value.trim();
  if (!raw || Number(raw) <= 0) return null;
  try { return parseUnits(raw, inDecimals()); } catch { return null; }
}

// ---------------------------------------------------------------- market
async function loadMarket() {
  try {
    await verifyToken();
    state.market = await readMarket();
    $("m-status").textContent = state.market.graduated ? "Graduated · live pool" : `Curve status ${state.market.status}`;
    const poolLink = $<HTMLAnchorElement>("m-pool");
    poolLink.textContent = short(state.market.pool);
    poolLink.href = `${EXPLORER}/address/${state.market.pool}`;
    const oneTamm = 10n ** BigInt(TAMM.decimals);
    const ethPerTamm = await quote(state.market, "sell", oneTamm);
    $("m-price").textContent = `1 $tAMM ≈ ${fmt(ethPerTamm, 18, 8)} test ETH`;
    $("m-block").textContent = `#${(await publicClient.getBlockNumber()).toLocaleString("en-US")}`;
  } catch (e) {
    $("m-status").textContent = "Unavailable";
    setStatus(`Could not read the market: ${errText(e)}`, "err");
  }
}

// ---------------------------------------------------------------- wallet
async function ensureChain() {
  const eth = window.ethereum!;
  const hex = `0x${CHAIN_ID.toString(16)}`;
  const current = (await eth.request({ method: "eth_chainId" })) as string;
  if (parseInt(current, 16) === CHAIN_ID) return;
  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
  } catch (err) {
    if ((err as { code?: number }).code !== 4902) throw err;
    await eth.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: hex, chainName: "GIWA Sepolia",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: [RPC_URL], blockExplorerUrls: [EXPLORER],
      }],
    });
  }
}

async function connect() {
  if (!window.ethereum) {
    setStatus("No wallet found. Install MetaMask, Rabby or another browser wallet, then reload.", "err");
    return;
  }
  try {
    const accounts = (await window.ethereum.request({ method: "eth_requestAccounts" })) as string[];
    await ensureChain();
    state.account = accounts[0] as Address;
    state.wallet = createWalletClient({ chain: giwaSepolia, transport: custom(window.ethereum) });
    $("connect").textContent = short(state.account);
    $("connect").classList.add("connected");
    await refreshBalances();
    setStatus("Wallet connected on GIWA Sepolia.", "ok");
  } catch (e) {
    setStatus(`Connection failed: ${errText(e)}`, "err");
  }
  render();
}

async function refreshBalances() {
  if (!state.account) return;
  state.bal = await balances(state.account);
  render();
}

// ---------------------------------------------------------------- quoting
let quoteTimer: number | undefined;
function scheduleQuote() {
  state.quoteOut = null;
  render();
  window.clearTimeout(quoteTimer);
  quoteTimer = window.setTimeout(runQuote, 350);
}

async function runQuote() {
  const amount = parseAmount();
  if (!amount || !state.market) { render(); return; }
  try {
    state.quoteOut = await quote(state.market, state.side, amount);
  } catch (e) {
    setStatus(`Quote failed: ${errText(e)}`, "err");
  }
  render();
}

// ---------------------------------------------------------------- swap
async function send(tx: { to: Address; data: Hex; value: bigint }) {
  const hash = await state.wallet!.sendTransaction({
    account: state.account!, chain: giwaSepolia, to: tx.to, data: tx.data, value: tx.value,
  });
  setStatus("Sent. Waiting for confirmation…", "info", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The transaction reverted on-chain. Nothing was swapped.");
  return hash;
}

async function swap() {
  if (!state.account || !state.wallet) { await connect(); return; }
  const amount = parseAmount();
  if (!amount || !state.market) return;
  state.busy = true; render();
  try {
    await ensureChain();
    // Always swap against a fresh quote, never a stale one.
    const expected = await quote(state.market, state.side, amount);
    if (state.side === "sell") {
      const bal = await balances(state.account);
      if (bal.allowance < amount) {
        setStatus("Step 1 of 2: approve the router to spend this exact $tAMM amount…");
        await send({
          to: TAMM.token, value: 0n,
          data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [TAMM.router, amount] }),
        });
      }
    }
    const tx = state.side === "buy"
      ? buildBuy(state.market, amount, expected, state.account)
      : buildSell(state.market, amount, expected, state.account);
    setStatus("Simulating the swap before asking for your signature…");
    await simulate(state.account, tx);
    setStatus("Confirm the swap in your wallet…");
    const hash = await send(tx);
    setStatus(`Done. Swapped ${fmt(amount, inDecimals())} ${inSymbol()} for about ${fmt(expected, outDecimals())} ${outSymbol()}.`, "ok", hash);
    $<HTMLInputElement>("amount").value = "";
    state.quoteOut = null;
    await Promise.all([refreshBalances(), loadMarket()]);
  } catch (e) {
    setStatus(errText(e), "err");
  } finally {
    state.busy = false; render();
  }
}

function errText(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string; code?: number };
  if (err?.code === 4001) return "You rejected the request in your wallet.";
  return (err?.shortMessage || err?.message || "Something went wrong").slice(0, 220);
}

// ---------------------------------------------------------------- render
function render() {
  $("tab-buy").classList.toggle("active", state.side === "buy");
  $("tab-sell").classList.toggle("active", state.side === "sell");
  $("in-label").textContent = `You pay (${inSymbol()})`;
  $("out-label").textContent = `You receive (${outSymbol()})`;
  $("out-value").textContent = state.quoteOut === null ? "—" : fmt(state.quoteOut, outDecimals());
  $("min-value").textContent = state.quoteOut === null ? "—"
    : `${fmt((state.quoteOut * 99n) / 100n, outDecimals())} ${outSymbol()}`;

  document.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((b) => {
    const p = b.dataset.preset!;
    b.textContent = p === "max" ? "Max" : state.side === "buy" ? `${p} ETH` : `${Math.round(Number(p) * 1000)} $tAMM`;
  });

  const bal = state.bal;
  $("in-balance").textContent = !bal ? "Balance: connect wallet"
    : `Balance: ${state.side === "buy" ? fmt(bal.eth, 18) + " ETH" : fmt(bal.tamm, TAMM.decimals) + " $tAMM"}`;
  $("b-eth").textContent = bal ? fmt(bal.eth, 18) : "—";
  $("b-tamm").textContent = bal ? fmt(bal.tamm, TAMM.decimals) : "—";

  const btn = $<HTMLButtonElement>("swap");
  const amount = parseAmount();
  if (!state.account) { btn.textContent = "Connect wallet"; btn.disabled = false; }
  else if (state.busy) { btn.textContent = "Working…"; btn.disabled = true; }
  else if (!amount) { btn.textContent = "Enter an amount"; btn.disabled = true; }
  else if (bal && amount > (state.side === "buy" ? bal.eth : bal.tamm)) { btn.textContent = "Not enough balance"; btn.disabled = true; }
  else { btn.textContent = state.side === "buy" ? "Swap ETH → $tAMM" : "Swap $tAMM → ETH"; btn.disabled = state.quoteOut === null; }
}

// ---------------------------------------------------------------- wire up
$("connect").addEventListener("click", connect);
$("swap").addEventListener("click", swap);
$("amount").addEventListener("input", (ev) => {
  const el = ev.target as HTMLInputElement;
  el.value = el.value.replace(",", ".").replace(/[^0-9.]/g, "");
  scheduleQuote();
});
for (const side of ["buy", "sell"] as const) {
  $(`tab-${side}`).addEventListener("click", () => {
    state.side = side;
    $<HTMLInputElement>("amount").value = "";
    scheduleQuote();
  });
}
document.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((b) =>
  b.addEventListener("click", () => {
    const p = b.dataset.preset!;
    const input = $<HTMLInputElement>("amount");
    if (p === "max") {
      if (!state.bal) return;
      // keep a little ETH back for gas
      const v = state.side === "buy"
        ? (state.bal.eth > 10n ** 15n ? state.bal.eth - 10n ** 15n : 0n)
        : state.bal.tamm;
      input.value = formatUnits(v, inDecimals());
    } else {
      // buy presets are in ETH (0.001 / 0.005 / 0.01); sell presets are 1 / 5 / 10 $tAMM
      input.value = state.side === "buy" ? p : String(Math.round(Number(p) * 1000));
    }
    scheduleQuote();
  }),
);
$<HTMLAnchorElement>("faucet").href = FAUCET;
$<HTMLAnchorElement>("token-link").href = `${EXPLORER}/token/${TAMM.token}`;
$<HTMLAnchorElement>("router-link").href = `${EXPLORER}/address/${TAMM.router}`;
window.ethereum?.on?.("accountsChanged", () => location.reload());
window.ethereum?.on?.("chainChanged", () => location.reload());

render();
void loadMarket();
window.setInterval(() => { void loadMarket(); void refreshBalances(); }, 30_000);
