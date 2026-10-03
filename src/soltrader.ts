import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
  TransactionInstruction,
  LAMPORTS_PER_SOL,
  SendTransactionError
} from "@solana/web3.js";
import { SOLANA } from "./config.js";
import type { Store } from "./store.js";
import { fetchTokenInfoBySlug } from "./tokeninfo.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
// Token-2022 extensions that let a dev freeze/seize/block your sell = honeypot vectors.
const RISKY_EXTENSIONS = new Set(["transferHook", "permanentDelegate", "transferFeeConfig", "defaultAccountState", "confidentialTransferMint", "pausable"]);
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_DECIMALS = 6;

/**
 * Jupiter hosts with free failover. On 429/5xx we try the next host so a
 * rate-limit on one endpoint does not brick sells.
 * Order: official api → free lite → public community proxy.
 * (Legacy quote-api.jup.ag/v6 is dead and intentionally omitted.)
 */
const JUP_BASES = (): string[] => [
  "https://api.jup.ag/swap/v1",
  "https://lite-api.jup.ag/swap/v1",
  "https://public.jupiterapi.com"
];

const priorityFeeLamports = (mode: "cheap" | "normal" | "ape") => {
  if (mode === "ape") return 100_000;
  if (mode === "normal") return 10_000;
  return 0;
};
const MIN_SOL_FOR_FEES = 0.003;
const lamportsToSol = (n: number | bigint) => Number(n) / LAMPORTS_PER_SOL;

// Serialize Jupiter HTTP so auto-exit valuations + sells don't stampede the free tier.
let jupChain: Promise<unknown> = Promise.resolve();
let lastJupAt = 0;
const JUP_MIN_GAP_MS = 400;

async function jupGate<T>(fn: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const prev = jupChain;
  jupChain = new Promise<void>(r => { release = r; });
  await prev.catch(() => {});
  const wait = Math.max(0, JUP_MIN_GAP_MS - (Date.now() - lastJupAt));
  if (wait) await new Promise(r => setTimeout(r, wait));
  try {
    const out = await fn();
    lastJupAt = Date.now();
    return out;
  } finally {
    lastJupAt = Date.now();
    release();
  }
}

// The public Solana RPC (and Jupiter's free endpoints) drop connections under load —
// undici surfaces that as "fetch failed" / ECONNRESET / 429. Pre-commit reads are safe
// to retry; sell quotes MUST survive rate-limits or we miss the exit.
const isTransientNetErr = (e: any): boolean => {
  for (let cur = e, i = 0; i < 6 && cur; i++, cur = cur.cause) {
    const s = `${cur.code ?? ""} ${cur.message ?? cur} ${cur.status ?? ""}`.toLowerCase();
    if (/fetch failed|econnreset|etimedout|timeout|terminated|socket|enotfound|eai_again|429|rate.?limit|503|502|504|too many requests/.test(s)) return true;
  }
  return false;
};
const isRateLimited = (e: any): boolean => {
  const s = `${e?.message ?? e}`.toLowerCase();
  return /429|rate.?limit|too many requests/.test(s);
};

/** RPC sim rejects oversized VersionedTransactions (base64 max ~1644 / raw ~1232). */
const isTxTooLargeErr = (e: any): boolean => {
  const s = `${e?.message ?? e}`.toLowerCase();
  return /too large|max:\s*encoded|versionedtransaction too large|1644|1232|transaction is too large/.test(s);
};

// Solana legacy/v0 sim size cap — refuse to send builds above this base64 length.
const MAX_B64_TX = 1644;
// Prefer lean routes so multi-hop pump.fun paths don't blow the sim limit.
const DEFAULT_MAX_ACCOUNTS = 48;
const TIGHT_MAX_ACCOUNTS = [48, 40, 32, 28] as const;
async function retryNet<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
  let last: any;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      if (i === tries - 1 || !isTransientNetErr(e)) throw e;
      // 429 needs a long cool-down; short blips can retry faster.
      const delay = isRateLimited(e)
        ? Math.min(25_000, 1_200 * 2 ** i) + Math.floor(Math.random() * 500)
        : 350 * (i + 1);
      console.warn(`[jup] retry ${i + 1}/${tries} after ${delay}ms: ${String((e as any)?.message ?? e).slice(0, 120)}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw last;
}

interface JupiterQuote {
  inAmount: string;
  outAmount: string;
  inputMint: string;
  outputMint: string;
  [key: string]: unknown;
}

/** Short-lived quote cache so positionValue polls don't re-hit Jupiter every 2s. */
const quoteCache = new Map<string, { at: number; data: JupiterQuote }>();
const QUOTE_CACHE_MS = 20_000;

const hostOf = (base: string) => {
  try { return new URL(base).host; } catch { return base; }
};

export interface SolExecutedTrade {
  network: "solana";
  direction: "buy" | "sell";
  token: string;
  symbol: string;
  signature: string;
  detail: string;
  pnlQuote?: number;
  quoteSymbol?: "SOL" | "USDC";
  pnlPct?: number;
}

export class SolTrader {
  readonly connection = new Connection(SOLANA.rpcUrl, "confirmed");
  readonly keypair: Keypair | null;

  constructor(private store: Store) {
    this.keypair = SOLANA.privateKey ? parseSolanaKeypair(SOLANA.privateKey) : null;
  }

  get enabled(): boolean {
    return !!this.keypair;
  }

  get publicKey(): PublicKey | null {
    return this.keypair?.publicKey ?? null;
  }

  async solBalance(): Promise<number | null> {
    if (!this.keypair) return null;
    const lamports = await this.connection.getBalance(this.keypair.publicKey);
    return lamports / LAMPORTS_PER_SOL;
  }

  async usdcBalance(): Promise<number | null> {
    const bal = await this.tokenBalance(USDC_MINT);
    return bal?.uiAmount ?? 0;
  }

  async tokenBalance(mint: string): Promise<{ amount: bigint; decimals: number; uiAmount: number } | null> {
    if (!this.keypair) return null;
    const owner = this.keypair.publicKey;
    const mintPk = new PublicKey(mint);
    const accounts = await this.connection.getParsedTokenAccountsByOwner(owner, { mint: mintPk });
    let raw = 0n;
    let decimals = 0;
    for (const a of accounts.value) {
      const info: any = a.account.data.parsed.info;
      decimals = Number(info.tokenAmount.decimals ?? decimals);
      raw += BigInt(info.tokenAmount.amount ?? "0");
    }
    return { amount: raw, decimals, uiAmount: Number(raw) / 10 ** decimals };
  }

  /**
   * Mark a Solana position to market.
   * - Default: DexScreener first; Jupiter only as rare fallback (cached).
   * - `jupiterFallback: false` — UI Live refresh / non-critical views. NEVER
   *   touches Jupiter, so it cannot steal rate-limit budget from real sells.
   */
  async positionValue(
    mint: string,
    opts: { jupiterFallback?: boolean } = {}
  ): Promise<{
    symbol: string;
    uiAmount: number;
    quoteSymbol: "SOL" | "USDC";
    proceedsQuote?: number;
    costQuote?: number;
    pnlQuote?: number;
    pnlPct?: number;
  } | null> {
    const jupiterFallback = opts.jupiterFallback !== false;
    const pos = this.store.position(mint, "solana");
    if (!pos) return null;
    const bal = await this.tokenBalance(mint);
    if (!bal || bal.amount === 0n) return null;
    const quote = this.quoteAssetForPosition(pos.quoteSymbol);
    let proceedsQuote: number | undefined;

    // CRITICAL: do NOT hit Jupiter on every auto-exit tick (every 2s). That was
    // burning the free Jupiter rate limit and making REAL sells fail with 429 —
    // money left on the table. DexScreener is free and good enough for monitoring
    // peaks / trailing SL / fixed SL. Live sells still use a fresh Jupiter quote.
    const info = await fetchTokenInfoBySlug("solana", mint).catch(() => null);
    if (info?.priceUsd && info.priceUsd > 0) {
      if (quote.symbol === "USDC") {
        proceedsQuote = bal.uiAmount * info.priceUsd;
      } else if (info.priceNative && info.priceNative > 0) {
        // priceNative = token price in SOL on most Solana pairs
        proceedsQuote = bal.uiAmount * info.priceNative;
      }
      // Last-resort SOL mark: USD value / SOL-USD (still no Jupiter call).
      if (proceedsQuote === undefined && quote.symbol === "SOL") {
        const solInfo = await fetchTokenInfoBySlug("solana", SOL_MINT).catch(() => null);
        if (solInfo?.priceUsd && solInfo.priceUsd > 0) {
          proceedsQuote = (bal.uiAmount * info.priceUsd) / solInfo.priceUsd;
        }
      }
    }

    // Only if market mark failed AND caller allows it: cached Jupiter fallback.
    // Live token-view auto-refresh must pass jupiterFallback:false.
    if (proceedsQuote === undefined && jupiterFallback) {
      try {
        const q = await this.quote(mint, quote.mint, bal.amount.toString(), this.store.settings.solSlippageBps, {
          allowCache: true,
          maxTries: 2
        });
        proceedsQuote = Number(q.outAmount) / 10 ** quote.decimals;
      } catch {
        /* no executable sell quote right now */
      }
    }

    const costQuote = pos.quoteSymbol === quote.symbol ? pos.costQuote : undefined;
    const pnlQuote = proceedsQuote !== undefined && costQuote !== undefined
      ? proceedsQuote - costQuote
      : undefined;
    const pnlPct = pnlQuote !== undefined && costQuote && costQuote > 0
      ? (pnlQuote / costQuote) * 100
      : undefined;
    return { symbol: pos.symbol, uiAmount: bal.uiAmount, quoteSymbol: quote.symbol, proceedsQuote, costQuote, pnlQuote, pnlPct };
  }

  /**
   * Honeypot pre-check: returns a reason string if the mint can freeze/seize/block
   * your sell (live freeze authority, or a Token-2022 freeze/hook/seize extension) —
   * else null. One RPC read. Fail-open on RPC error (null) so a blip doesn't halt
   * all trading; the buy below also enforces it. This is what catches $SUCK/$0XDEAD.
   */
  async mintHoneypotRisk(mint: string): Promise<string | null> {
    try {
      const info = await this.connection.getParsedAccountInfo(new PublicKey(mint));
      const v: any = info.value;
      if (!v) return null;
      const parsed = v.data?.parsed?.info;
      if (parsed?.freezeAuthority) return "live freeze authority";
      const owner = v.owner?.toBase58?.() ?? String(v.owner);
      if (owner === TOKEN_2022_PROGRAM) {
        const bad = (parsed?.extensions ?? [])
          .map((e: any) => e.extension)
          .find((e: string) => RISKY_EXTENSIONS.has(e));
        if (bad) return `token-2022 ${bad}`;
      }
      return null;
    } catch {
      return null;
    }
  }

  async buy(mint: string, amountInUi: number): Promise<SolExecutedTrade> {
    if (!this.keypair) throw new Error("Solana trading is not configured — set SOLANA_PRIVATE_KEY");
    if (!(amountInUi > 0)) throw new Error("Solana buy amount must be positive");
    // Hard backstop for manual buys: never buy a freezable/seizable token.
    const risk = await this.mintHoneypotRisk(mint);
    if (risk) throw new Error(`skipped — honeypot risk (${risk}); you could buy but not sell`);
    const quoteAsset = this.quoteAsset();
    // All pre-commit reads — retry transient RPC/Jupiter blips so a momentary
    // "fetch failed" doesn't abort a valid buy (nothing is spent until swap()).
    await retryNet(() => this.assertCanPay(quoteAsset, amountInUi));
    const rawAmount = Math.floor(amountInUi * 10 ** quoteAsset.decimals);
    const amountStr = String(rawAmount);
    // Ensure a sell route exists (honeypot probe) on a lean quote first.
    const probeQuote = await retryNet(() =>
      this.quote(quoteAsset.mint, mint, amountStr, this.store.settings.solSlippageBps, {
        maxAccounts: DEFAULT_MAX_ACCOUNTS,
        maxTries: 4
      }));
    await retryNet(() => this.ensureSellRoute(mint, probeQuote.outAmount));
    // Buy via size-aware path: if the TX is too fat for RPC sim, tighten maxAccounts.
    const { signature, quote } = await this.swapResilient(
      quoteAsset.mint,
      mint,
      amountStr,
      this.store.settings.solSlippageBps,
      probeQuote
    );
    // ⚠️ Swap has CONFIRMED — money is committed. From here we must NEVER throw, or
    // we'd hold an untracked, unmanaged token (no ladder/stop). The balance read can
    // lag right after the buy, so retry it — but record the position regardless.
    const info = await fetchTokenInfoBySlug("solana", mint).catch(() => null);
    let bal: Awaited<ReturnType<SolTrader["tokenBalance"]>> = null;
    for (let i = 0; i < 4 && !bal; i++) {
      bal = await this.tokenBalance(mint).catch(() => null);
      if (!bal) await new Promise(r => setTimeout(r, 700));
    }
    const symbol = info?.symbol ?? "TOKEN";
    const prev = this.store.position(mint, "solana");
    this.store.upsertPosition({
      token: mint,
      network: "solana",
      symbol,
      decimals: bal?.decimals ?? prev?.decimals ?? 6,
      amount: bal?.amount.toString() ?? quote.outAmount,
      costQuote: (prev?.costQuote ?? 0) + amountInUi,
      quoteSymbol: quoteAsset.symbol,
      openedAt: prev?.openedAt ?? Date.now()
    });
    this.store.recordMyTrade({
      token: mint,
      network: "solana",
      direction: "buy",
      at: Date.now(),
      txHash: signature,
      priceUsd: info?.priceUsd,
      marketCap: info?.marketCap ?? info?.fdv
    });
    return {
      network: "solana",
      direction: "buy",
      token: mint,
      symbol,
      signature,
      detail: `spent ${amountInUi} ${quoteAsset.symbol} via Jupiter (${this.store.settings.solFeeMode} fee mode)`
    };
  }

  async sell(mint: string, pct: number): Promise<SolExecutedTrade> {
    if (!this.keypair) throw new Error("Solana trading is not configured — set SOLANA_PRIVATE_KEY");
    await this.assertFeeSol();
    const bal = await this.tokenBalance(mint);
    if (!bal || bal.amount === 0n) throw new Error("nothing to sell");
    const amount = (bal.amount * BigInt(Math.min(100, Math.max(1, Math.round(pct))))) / 100n;
    if (amount === 0n) throw new Error("sell amount rounds to zero");
    const pos = this.store.position(mint, "solana");
    const quoteAsset = this.quoteAssetForPosition(pos?.quoteSymbol);
    // Size-aware sell: multi-host quote + maxAccounts ladder so fat multi-hop
    // routes don't die with "VersionedTransaction too large".
    const { signature, quote } = await this.swapResilient(
      mint,
      quoteAsset.mint,
      amount.toString(),
      this.store.settings.solSlippageBps
    );
    const info = await fetchTokenInfoBySlug("solana", mint).catch(() => null);
    const proceeds = Number(quote.outAmount) / 10 ** quoteAsset.decimals;
    const soldFraction = bal.amount > 0n ? Number(amount) / Number(bal.amount) : 0;
    const costBasis = pos?.costQuote && pos.quoteSymbol === quoteAsset.symbol
      ? pos.costQuote * soldFraction
      : undefined;
    const pnlQuote = costBasis !== undefined ? proceeds - costBasis : undefined;
    const pnlPct = costBasis && costBasis > 0 ? (pnlQuote! / costBasis) * 100 : undefined;
    if (pnlQuote !== undefined) this.store.recordMyPnl(quoteAsset.symbol, pnlQuote);
    this.store.recordMyTrade({
      token: mint,
      network: "solana",
      direction: "sell",
      at: Date.now(),
      txHash: signature,
      priceUsd: info?.priceUsd,
      marketCap: info?.marketCap ?? info?.fdv
    });
    if (pct >= 100) {
      this.store.removePosition(mint, "solana");
      // Auto-reclaim the emptied account's ~0.002 SOL rent (best-effort, non-blocking).
      void this.reclaimEmptyAccount(mint).catch(() => {});
    } else if (pos) {
      this.store.upsertPosition({
        ...pos,
        amount: (bal.amount - amount).toString(),
        costQuote: pos.costQuote ? pos.costQuote * (1 - soldFraction) : undefined
      });
    }
    return {
      network: "solana",
      direction: "sell",
      token: mint,
      symbol: info?.symbol ?? pos?.symbol ?? "TOKEN",
      signature,
      detail: `sold ${pct}% for ~${proceeds.toFixed(quoteAsset.symbol === "USDC" ? 2 : 5)} ${quoteAsset.symbol}`,
      pnlQuote,
      quoteSymbol: quoteAsset.symbol,
      pnlPct
    };
  }

  /**
   * Reclaim the ~0.002 SOL rent locked in a now-empty SPL token account after a
   * full sell (what Jupiter's "reclaim SOL" button does, but automatic). Strictly
   * best-effort: any failure is swallowed so it can never affect the sell — worst
   * case the rent just stays put, exactly as before. Returns reclaimed SOL or null.
   */
  private async reclaimEmptyAccount(mint: string): Promise<number | null> {
    if (!this.keypair) return null;
    try {
      const owner = this.keypair.publicKey;
      const accounts = await this.connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
      const empty = accounts.value.find(a => a.account.data.parsed?.info?.tokenAmount?.amount === "0");
      if (!empty) return null; // not empty yet (or already closed) — skip
      const rentLamports = await this.connection.getBalance(empty.pubkey).catch(() => 0);
      // SPL Token `CloseAccount` (instruction 9): [account, rent destination, owner].
      // programId from the account's owner so Token-2022 accounts work too.
      const ix = new TransactionInstruction({
        programId: empty.account.owner,
        keys: [
          { pubkey: empty.pubkey, isSigner: false, isWritable: true },
          { pubkey: owner, isSigner: false, isWritable: true },
          { pubkey: owner, isSigner: true, isWritable: false }
        ],
        data: Buffer.from([9])
      });
      const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
      const tx = new VersionedTransaction(
        new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message()
      );
      tx.sign([this.keypair]);
      const sig = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 2 });
      const conf = await this.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      if (conf.value.err) return null;
      return lamportsToSol(rentLamports);
    } catch {
      return null;
    }
  }

  /** Sweep ALL empty token accounts (both programs) and reclaim their rent SOL.
   *  Batches the CloseAccount instructions. Returns count closed + SOL recovered. */
  async reclaimAllEmptyAccounts(): Promise<{ closed: number; reclaimedSol: number }> {
    if (!this.keypair) throw new Error("Solana trading is not configured — set SOLANA_PRIVATE_KEY");
    const owner = this.keypair.publicKey;
    const empties: { pubkey: PublicKey; program: PublicKey; rent: number }[] = [];
    for (const prog of ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", TOKEN_2022_PROGRAM]) {
      const accs = await this.connection.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(prog) }).catch(() => null);
      if (!accs) continue;
      for (const a of accs.value) {
        if (a.account.data.parsed?.info?.tokenAmount?.amount === "0") {
          empties.push({ pubkey: a.pubkey, program: a.account.owner, rent: a.account.lamports });
        }
      }
    }
    if (empties.length === 0) return { closed: 0, reclaimedSol: 0 };
    let closed = 0, reclaimed = 0;
    const BATCH = 12; // tiny ixs — well under the tx size limit
    for (let i = 0; i < empties.length; i += BATCH) {
      const chunk = empties.slice(i, i + BATCH);
      const ixs = chunk.map(e => new TransactionInstruction({
        programId: e.program,
        keys: [
          { pubkey: e.pubkey, isSigner: false, isWritable: true },
          { pubkey: owner, isSigner: false, isWritable: true },
          { pubkey: owner, isSigner: true, isWritable: false }
        ],
        data: Buffer.from([9])
      }));
      try {
        const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash("confirmed");
        const tx = new VersionedTransaction(
          new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message()
        );
        tx.sign([this.keypair]);
        const sig = await this.connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 2 });
        const conf = await this.connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
        if (!conf.value.err) { closed += chunk.length; reclaimed += chunk.reduce((s, e) => s + lamportsToSol(e.rent), 0); }
      } catch { /* skip this batch, keep going */ }
    }
    return { closed, reclaimedSol: reclaimed };
  }

  /** Import a Solana token you already hold into tracked positions (reads real
   *  on-chain balance; estimates cost basis from the current sell quote). */
  async recoverPosition(mint: string): Promise<{ symbol: string; uiAmount: number } | null> {
    if (!this.keypair) return null;
    const bal = await this.tokenBalance(mint).catch(() => null);
    if (!bal || bal.amount === 0n) return null;
    const info = await fetchTokenInfoBySlug("solana", mint).catch(() => null);
    const prev = this.store.position(mint, "solana");
    const quoteAsset = this.quoteAssetForPosition(prev?.quoteSymbol);
    let costQuote = prev?.costQuote;
    if (costQuote === undefined) {
      try {
        const q = await this.quote(mint, quoteAsset.mint, bal.amount.toString(), this.store.settings.solSlippageBps);
        costQuote = Number(q.outAmount) / 10 ** quoteAsset.decimals; // cost ≈ current value
      } catch { /* no route to price it — leave cost undefined */ }
    }
    const symbol = info?.symbol ?? "TOKEN";
    this.store.upsertPosition({
      token: mint, network: "solana", symbol,
      decimals: bal.decimals, amount: bal.amount.toString(),
      costQuote, quoteSymbol: quoteAsset.symbol,
      openedAt: prev?.openedAt ?? Date.now()
    });
    return { symbol, uiAmount: bal.uiAmount };
  }

  /** Scan every non-empty token account and import any untracked holdings. */
  async syncHeldPositions(): Promise<{ added: number; updated: number; scanned: number }> {
    if (!this.keypair) return { added: 0, updated: 0, scanned: 0 };
    const owner = this.keypair.publicKey;
    let added = 0, updated = 0, scanned = 0;
    for (const prog of ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", TOKEN_2022_PROGRAM]) {
      const accs = await this.connection.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey(prog) }).catch(() => null);
      if (!accs) continue;
      for (const a of accs.value) {
        const pi = a.account.data.parsed?.info;
        const mint = pi?.mint;
        const amt = pi?.tokenAmount?.amount;
        if (!mint || !amt || amt === "0") continue;
        if (mint === USDC_MINT || mint === SOL_MINT) continue; // skip quote assets
        scanned++;
        const existed = !!this.store.position(mint, "solana");
        const r = await this.recoverPosition(mint).catch(() => null);
        if (r) { existed ? updated++ : added++; }
      }
    }
    return { added, updated, scanned };
  }

  private async ensureSellRoute(mint: string, amount: string) {
    const probe = BigInt(amount) / 2n || BigInt(amount);
    if (probe <= 0n) throw new Error("buy quote returned zero tokens");
    const quoteAsset = this.quoteAsset();
    await this.quote(mint, quoteAsset.mint, probe.toString(), this.store.settings.solSlippageBps);
  }

  private quoteAsset() {
    return this.store.settings.solQuote === "USDC"
      ? { mint: USDC_MINT, decimals: USDC_DECIMALS, symbol: "USDC" as const }
      : { mint: SOL_MINT, decimals: 9, symbol: "SOL" as const };
  }

  private quoteAssetForPosition(symbol?: string) {
    return symbol === "USDC"
      ? { mint: USDC_MINT, decimals: USDC_DECIMALS, symbol: "USDC" as const }
      : { mint: SOL_MINT, decimals: 9, symbol: "SOL" as const };
  }

  /**
   * Jupiter sell/buy quote with:
   *  - optional short cache (monitoring only)
   *  - multi-host free/paid failover on 429/5xx
   *  - maxAccounts to force leaner routes (avoids oversized VersionedTx)
   *  - exponential backoff via retryNet
   */
  private async quote(
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps: number,
    opts: { allowCache?: boolean; maxTries?: number; maxAccounts?: number } = {}
  ): Promise<JupiterQuote> {
    const { allowCache = false, maxTries = 6, maxAccounts = DEFAULT_MAX_ACCOUNTS } = opts;
    const cacheKey = `${inputMint}>${outputMint}:${amount}:${slippageBps}:a${maxAccounts}`;
    if (allowCache) {
      const hit = quoteCache.get(cacheKey);
      if (hit && Date.now() - hit.at < QUOTE_CACHE_MS) return hit.data;
    }

    const data = await retryNet(
      () => this.quoteAcrossHosts(inputMint, outputMint, amount, slippageBps, maxAccounts),
      maxTries
    );
    quoteCache.set(cacheKey, { at: Date.now(), data });
    // Bound cache size (auto-exit + many mints)
    if (quoteCache.size > 80) {
      const oldest = [...quoteCache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 40);
      for (const [k] of oldest) quoteCache.delete(k);
    }
    return data;
  }

  private async quoteAcrossHosts(
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps: number,
    maxAccounts = DEFAULT_MAX_ACCOUNTS
  ): Promise<JupiterQuote> {
    let lastErr: any;
    const bases = JUP_BASES();
    for (let i = 0; i < bases.length; i++) {
      const base = bases[i];
      try {
        const data = await jupGate(async () => {
          const url = new URL(`${base}/quote`);
          url.searchParams.set("inputMint", inputMint);
          url.searchParams.set("outputMint", outputMint);
          url.searchParams.set("amount", amount);
          url.searchParams.set("slippageBps", String(slippageBps));
          // Cap accounts so multi-hop routes stay under Solana sim size limits.
          if (maxAccounts > 0) url.searchParams.set("maxAccounts", String(maxAccounts));
          // Prefer direct/simpler routes when available (still falls back to multi-hop).
          url.searchParams.set("onlyDirectRoutes", "false");
          const res = await fetch(url, {
            headers: this.headers(base),
            signal: AbortSignal.timeout(12_000)
          });
          if (!res.ok) {
            const err: any = new Error(`Jupiter quote failed (${res.status}) via ${hostOf(base)}`);
            err.status = res.status;
            throw err;
          }
          const body: any = await res.json();
          if (!body?.outAmount || BigInt(body.outAmount) <= 0n) {
            throw new Error("Jupiter returned no route");
          }
          // Remember which host worked so swap build uses the same family.
          (body as any).__jupBase = base;
          (body as any).__maxAccounts = maxAccounts;
          return body as JupiterQuote;
        });
        return data;
      } catch (e: any) {
        lastErr = e;
        const status = e?.status ?? Number(String(e?.message).match(/\((\d{3})\)/)?.[1] ?? 0);
        // Hard client errors (except 429) won't succeed on another host with same params.
        if (status && status >= 400 && status < 500 && status !== 429) throw e;
        console.warn(`[jup] quote host ${hostOf(base)} failed (${status || e?.message}); trying next`);
      }
    }
    throw lastErr ?? new Error("Jupiter quote failed on all hosts");
  }

  /**
   * Execute a swap, automatically re-quoting with tighter maxAccounts when the
   * built TX exceeds Solana's simulation size limit (common on multi-hop memecoins).
   */
  private async swapResilient(
    inputMint: string,
    outputMint: string,
    amount: string,
    slippageBps: number,
    seedQuote?: JupiterQuote
  ): Promise<{ signature: string; quote: JupiterQuote }> {
    let lastErr: any;
    let first = true;
    for (const maxAccounts of TIGHT_MAX_ACCOUNTS) {
      try {
        const quote =
          first && seedQuote && ((seedQuote as any).__maxAccounts ?? DEFAULT_MAX_ACCOUNTS) <= maxAccounts
            ? seedQuote
            : await this.quote(inputMint, outputMint, amount, slippageBps, {
                allowCache: false,
                maxTries: 5,
                maxAccounts
              });
        first = false;
        const signature = await this.swap(quote, { maxAccounts });
        return { signature, quote };
      } catch (e: any) {
        lastErr = e;
        first = false;
        if (!isTxTooLargeErr(e)) throw e;
        console.warn(
          `[jup] tx too large with maxAccounts=${maxAccounts}: ${String(e?.message ?? e).slice(0, 120)} — tightening route`
        );
      }
    }
    throw new Error(
      `Solana swap failed: route still too large after lean routes (maxAccounts ${TIGHT_MAX_ACCOUNTS.join("→")}). ` +
      `Token may need a more direct pool. Original: ${String(lastErr?.message ?? lastErr).slice(0, 180)}`
    );
  }

  private async swap(
    quote: JupiterQuote,
    opts: { maxAccounts?: number } = {}
  ): Promise<string> {
    if (!this.keypair) throw new Error("Solana trading is not configured");
    const fee = priorityFeeLamports(this.store.settings.solFeeMode);
    const preferredBase = typeof (quote as any).__jupBase === "string" ? (quote as any).__jupBase as string : undefined;
    const baseBody: Record<string, unknown> = {
      quoteResponse: quote,
      userPublicKey: this.keypair.publicKey.toBase58(),
      dynamicComputeUnitLimit: true,
      wrapAndUnwrapSol: true
    };
    if (fee > 0) baseBody.prioritizationFeeLamports = fee;

    // Build variants: shared accounts first (usually smaller TX), then plain.
    // If still huge, drop priority fee (ape mode adds extra ixs).
    const variants: Record<string, unknown>[] = [
      { ...baseBody, useSharedAccounts: true },
      { ...baseBody, useSharedAccounts: false },
      { ...baseBody, useSharedAccounts: true, prioritizationFeeLamports: undefined },
      { ...baseBody, useSharedAccounts: false, prioritizationFeeLamports: undefined }
    ];

    let lastErr: any;
    for (const body of variants) {
      // Strip undefined keys so JSON doesn't send "prioritizationFeeLamports": null weirdly
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body)) {
        if (v !== undefined) clean[k] = v;
      }
      try {
        const data = await retryNet(
          () => this.buildSwapTxAcrossHosts(clean, preferredBase),
          3
        );
        if (!data?.swapTransaction) throw new Error("Jupiter did not return a swap transaction");
        const b64: string = data.swapTransaction;
        if (b64.length > MAX_B64_TX) {
          const err: any = new Error(
            `VersionedTransaction too large: ${b64.length} bytes base64 (max ${MAX_B64_TX}); maxAccounts=${opts.maxAccounts ?? "?"}`
          );
          lastErr = err;
          console.warn(`[jup] built swap oversized (${b64.length} b64) — trying leaner build variant`);
          continue;
        }
        const tx = VersionedTransaction.deserialize(Buffer.from(b64, "base64"));
        tx.sign([this.keypair]);
        // Network limit ~1232 raw bytes. Check after sign (sigs replace empty placeholders).
        const rawLen = tx.serialize().length;
        if (rawLen > 1232) {
          const err: any = new Error(
            `VersionedTransaction too large: raw ${rawLen} bytes (max 1232); maxAccounts=${opts.maxAccounts ?? "?"}`
          );
          lastErr = err;
          continue;
        }
        await this.preflightCost(tx, quote);
        let sig: string;
        try {
          sig = await this.connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: false,
            maxRetries: 3
          });
        } catch (e) {
          // Size errors sometimes only surface on send/sim — bubble for outer ladder.
          if (isTxTooLargeErr(e)) throw e;
          throw new Error(await this.describeSendError(e));
        }
        const latest = await this.connection.getLatestBlockhash("confirmed");
        const conf = await this.connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
        if (conf.value.err) throw new Error(`Solana swap failed: ${JSON.stringify(conf.value.err)}`);
        return sig;
      } catch (e: any) {
        lastErr = e;
        if (isTxTooLargeErr(e)) {
          console.warn(`[jup] swap variant hit size limit — trying next build`);
          continue;
        }
        // Non-size hard failures (e.g. 400 shared accounts) → try next variant once.
        const msg = String(e?.message ?? e);
        if (/shared.?account|useSharedAccounts|400/i.test(msg)) {
          console.warn(`[jup] swap variant rejected (${msg.slice(0, 100)}) — trying next`);
          continue;
        }
        throw e;
      }
    }
    throw lastErr ?? new Error("Jupiter swap build failed on all variants");
  }

  private async buildSwapTxAcrossHosts(
    body: Record<string, unknown>,
    preferredBase?: string
  ): Promise<any> {
    const bases = preferredBase
      ? [preferredBase, ...JUP_BASES().filter(b => b !== preferredBase)]
      : JUP_BASES();
    let lastErr: any;
    for (const base of bases) {
      try {
        return await jupGate(() => this.buildSwapTx(base, body));
      } catch (e: any) {
        lastErr = e;
        const status = e?.status ?? Number(String(e?.message).match(/\((\d{3})\)/)?.[1] ?? 0);
        if (status && status >= 400 && status < 500 && status !== 429) throw e;
        console.warn(`[jup] swap host ${hostOf(base)} failed (${status || e?.message}); trying next`);
      }
    }
    throw lastErr ?? new Error("Jupiter swap build failed on all hosts");
  }

  private async buildSwapTx(base: string, body: Record<string, unknown>): Promise<any> {
    const res = await fetch(`${base}/swap`, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.headers(base) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000)
    });
    if (!res.ok) {
      // Jupiter returns a JSON body like {"error":"...","errorCode":"..."} on 4xx —
      // surface it instead of a bare status so the failure is actually diagnosable.
      const detail = await res.text().catch(() => "");
      let reason = "";
      try {
        const j = JSON.parse(detail);
        reason = j?.error || j?.message || "";
      } catch { reason = detail.slice(0, 180); }
      const err: any = new Error(`Jupiter swap build failed (${res.status})${reason ? `: ${reason}` : ""} via ${hostOf(base)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  private headers(base?: string): Record<string, string> {
    // API key only for official api.jup.ag (never send secrets to third-party proxies).
    if (
      SOLANA.jupiterApiKey
      && base
      && base.startsWith("https://api.jup.ag/")
    ) {
      return { "x-api-key": SOLANA.jupiterApiKey };
    }
    return {};
  }

  private async assertCanPay(quote: ReturnType<SolTrader["quoteAsset"]>, amount: number) {
    if (quote.symbol === "SOL") {
      const sol = await this.solBalance();
      if (sol === null || sol < amount + MIN_SOL_FOR_FEES) {
        throw new Error(`not enough SOL: need ~${(amount + MIN_SOL_FOR_FEES).toFixed(5)} SOL including fees/rent`);
      }
      return;
    }
    await this.assertFeeSol();
    const usdc = await this.usdcBalance();
    if (usdc === null || usdc < amount) {
      throw new Error(`not enough USDC: need ${amount} USDC`);
    }
  }

  private async preflightCost(tx: VersionedTransaction, quote: JupiterQuote) {
    if (!this.keypair) return;
    const payer = this.keypair.publicKey;
    const reclaimableRentLamports = await this.expectedNewAccountRentLamports(quote.outputMint);
    let sim: Awaited<ReturnType<Connection["simulateTransaction"]>>;
    try {
      sim = await this.connection.simulateTransaction(tx, {
        replaceRecentBlockhash: true,
        sigVerify: false,
        accounts: { encoding: "base64", addresses: [payer.toBase58()] }
      });
    } catch (e: any) {
      // Helius/public RPC throw before returning logs when the base64 packet is too big.
      if (isTxTooLargeErr(e)) throw e;
      throw e;
    }
    if (sim.value.err) {
      throw new Error(this.describeSimulation(sim.value.err, sim.value.logs ?? []));
    }
    const postLamports = sim.value.accounts?.[0]?.lamports;
    const currentLamports = await this.connection.getBalance(payer);
    if (postLamports === undefined || postLamports === null) return;
    const solInput = quote.inputMint === SOL_MINT ? Number(quote.inAmount ?? 0) : 0;
    const costLamports = currentLamports - postLamports - solInput;
    const costSol = lamportsToSol(costLamports);
    const feeLikeLamports = Math.max(0, costLamports - reclaimableRentLamports);
    const feeLikeSol = lamportsToSol(feeLikeLamports);
    if (costSol <= 0) return;
    const cap = this.store.settings.solMaxFeeSol;
    if (cap > 0 && feeLikeSol > cap) {
      const suggest = Math.max(0.01, Number((feeLikeSol * 1.25).toFixed(4)));
      throw new Error(
        `blocked: Solana route needs ~${feeLikeSol.toFixed(5)} SOL non-rent fee, above max ${cap} SOL. ` +
        `Total SOL delta is ~${costSol.toFixed(5)} SOL` +
        `${reclaimableRentLamports > 0 ? ` including ~${lamportsToSol(reclaimableRentLamports).toFixed(5)} SOL token-account rent` : ""}. ` +
        `Raise it: /setsolmaxfee ${suggest} (or Config → ◎ Solana → Max SOL fee). ` +
        `Tip: fee mode "${this.store.settings.solFeeMode}" — try "normal"/"cheap" for lower priority, or 0 to disable this guard.`
      );
    }
    if (postLamports < 0) {
      throw new Error(`not enough SOL: route needs ~${costSol.toFixed(5)} SOL for fees/rent`);
    }
  }

  private async expectedNewAccountRentLamports(outputMint: string): Promise<number> {
    if (!this.keypair) return 0;
    if (outputMint === SOL_MINT) return 0;
    const existing = await this.tokenBalance(outputMint).catch(() => null);
    if (existing && existing.amount > 0n) return 0;
    try {
      return await this.connection.getMinimumBalanceForRentExemption(165);
    } catch {
      // Current SPL token account rent on mainnet is usually 0.00203928 SOL.
      return 2_039_280;
    }
  }

  private describeSimulation(err: unknown, logs: string[]): string {
    // Match against BOTH the logs AND the structured err — Jupiter surfaces
    // failures as a Custom error code in `err` (often absent from the logs,
    // which can end on a misleading "Program ... success").
    const errStr = typeof err === "string" ? err : JSON.stringify(err ?? "");
    const hay = `${logs.join(" | ")} ${errStr}`;
    // Jupiter slippage = custom error 6001 (hex 0x1771). Check first so it isn't
    // mistaken for the generic insufficient-funds code 1.
    if (/slippage|ExceededSlippage|0x1771|"Custom":\s*6001/i.test(hay)) {
      return "Solana simulation failed: slippage exceeded — token moving too fast. Raise SOL slippage in Settings, or skip it.";
    }
    if (/insufficient (lamports|funds)|"Custom":\s*1\b/i.test(hay)) {
      return "Solana simulation failed: not enough SOL for this route's fees/rent/account setup. Fund more SOL, use a smaller buy, or switch quote to USDC.";
    }
    if (/owner does not match|IllegalOwner|account.*not initialized/i.test(hay)) {
      return "Solana simulation failed: token account setup failed. Route may need extra rent SOL.";
    }
    // Fallback now ALWAYS includes the real error code, then the log tail.
    const tail = logs.slice(-3).join(" | ");
    return `Solana simulation failed: ${errStr || "unknown error"}${tail ? ` | ${tail}` : ""}`;
  }

  private async assertFeeSol() {
    const sol = await this.solBalance();
    if (sol === null || sol < MIN_SOL_FOR_FEES) {
      throw new Error(`not enough SOL for Solana fees/rent; keep at least ${MIN_SOL_FOR_FEES} SOL even when using USDC`);
    }
  }

  private async describeSendError(e: unknown): Promise<string> {
    const anyErr: any = e;
    let logs: string[] = [];
    try {
      if (e instanceof SendTransactionError) logs = await e.getLogs(this.connection) ?? [];
      else if (typeof anyErr?.getLogs === "function") logs = await anyErr.getLogs(this.connection) ?? [];
      else if (Array.isArray(anyErr?.logs)) logs = anyErr.logs;
    } catch {
      /* best effort */
    }
    const joined = logs.join(" | ");
    if (/insufficient.*lamports|0x1|custom program error: 0x1/i.test(joined)) {
      return "Solana simulation failed: insufficient SOL for this route's fees/rent/account setup. Try smaller SOL buy, switch quote to USDC, or fund more SOL.";
    }
    if (/slippage|ExceededSlippage/i.test(joined)) {
      return "Solana simulation failed: slippage exceeded. Increase SOL slip in settings or avoid this moving token.";
    }
    if (/owner does not match|IllegalOwner|account.*not initialized/i.test(joined)) {
      return "Solana simulation failed: token account setup failed. Keep a little more SOL for account rent and try again.";
    }
    const msg = String(anyErr?.message ?? anyErr ?? "Simulation failed").split("\n")[0];
    if (isTxTooLargeErr(msg)) {
      return `failed to simulate transaction: VersionedTransaction too large — route has too many accounts. Will retry with a leaner Jupiter route.`;
    }
    const tail = logs.slice(-3).join(" | ");
    return tail ? `${msg}: ${tail}` : msg;
  }
}

export function parseSolanaKeypair(raw: string): Keypair {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed);
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  return Keypair.fromSecretKey(bs58.decode(trimmed));
}
