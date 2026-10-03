import { SOLANA } from "./config.js";
import type { Store } from "./store.js";

export interface DetectedSolTrade {
  wallet: string;
  walletLabel: string;
  signature: string;
  direction: "buy" | "sell";
  /** SPL mint address */
  mint: string;
  /** UI amount moved (already decimal-adjusted) */
  uiAmount: number;
  /** what the wallet paid (buys) or received (sells), when derivable */
  quoteAmount?: { amount: number; symbol: string };
}

type SolTradeHandler = (trade: DetectedSolTrade) => Promise<void>;

const WSOL_MINT = "So11111111111111111111111111111111111111112";
/** quote-side mints that mark the payment leg, not the traded token */
const QUOTE_MINTS = new Set([
  WSOL_MINT,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"  // USDT
]);

/**
 * Watch-only Solana tracker (trading comes in a later phase).
 *
 * One `logsSubscribe(mentions: wallet)` per tracked Solana wallet over a raw
 * JSON-RPC WebSocket (Node 22's built-in client — no extra deps). On each
 * signature we fetch the transaction and diff pre/post token balances for the
 * wallet: a non-quote mint increasing is a buy, decreasing is a sell. Only
 * transactions the wallet itself fee-paid count, which filters out airdrops.
 */
export class SolanaWatcher {
  private ws?: WebSocket;
  private running = false;
  private nextId = 1;
  /** rpc id -> wallet, so subscription confirmations can be mapped */
  private pendingSubs = new Map<number, string>();
  /** subscription id -> wallet */
  private subs = new Map<number, string>();
  private seen = new Map<string, number>();
  private reconnectDelay = 1000;

  constructor(
    private store: Store,
    private onTrade: SolTradeHandler,
    private onError: (msg: string) => void
  ) {}

  private trackedWallets(): string[] {
    return this.store
      .walletsByChain("solana")
      .filter(w => w.enabled)
      .map(w => w.address);
  }

  start() {
    this.running = true;
    if (this.trackedWallets().length > 0) this.connect();
  }

  stop() {
    this.running = false;
    this.ws?.close();
    this.ws = undefined;
  }

  /** Rebuild the connection after wallet changes (cheap: only if needed). */
  refresh() {
    if (!this.running) return;
    this.ws?.close(); // onclose triggers reconnect with the fresh wallet list
    if (!this.ws && this.trackedWallets().length > 0) this.connect();
  }

  private connect() {
    let ws: WebSocket;
    try {
      ws = new WebSocket(SOLANA.wsUrl);
    } catch (err: any) {
      this.onError(`[solana] websocket failed: ${err.message}`);
      return;
    }
    this.ws = ws;
    this.pendingSubs.clear();
    this.subs.clear();

    ws.onopen = () => {
      this.reconnectDelay = 1000;
      for (const wallet of this.trackedWallets()) {
        const id = this.nextId++;
        this.pendingSubs.set(id, wallet);
        ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "logsSubscribe",
          params: [{ mentions: [wallet] }, { commitment: "confirmed" }]
        }));
      }
    };

    ws.onmessage = ev => {
      try {
        const msg = JSON.parse(String(ev.data));
        // subscription confirmation: { id, result: <subscription id> }
        if (msg.id && this.pendingSubs.has(msg.id)) {
          const wallet = this.pendingSubs.get(msg.id)!;
          this.pendingSubs.delete(msg.id);
          if (typeof msg.result === "number") this.subs.set(msg.result, wallet);
          else this.onError(`[solana] subscribe failed for ${wallet}: ${JSON.stringify(msg.error)}`);
          return;
        }
        if (msg.method === "logsNotification") {
          const subId = msg.params?.subscription;
          const value = msg.params?.result?.value;
          const wallet = this.subs.get(subId);
          if (!wallet || !value?.signature || value.err) return;
          void this.handleSignature(value.signature, wallet);
        }
      } catch {
        /* non-JSON frame */
      }
    };

    ws.onerror = () => {
      /* onclose fires next; reconnect there */
    };

    ws.onclose = () => {
      this.ws = undefined;
      if (!this.running) return;
      if (this.trackedWallets().length === 0) return;
      setTimeout(() => this.running && !this.ws && this.connect(), this.reconnectDelay);
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    };
  }

  private async handleSignature(signature: string, wallet: string) {
    const now = Date.now();
    if (this.seen.has(signature)) return;
    this.seen.set(signature, now);
    if (this.seen.size > 500) {
      for (const [k, t] of this.seen) if (now - t > 300_000) this.seen.delete(k);
    }

    try {
      const res = await fetch(SOLANA.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: [signature, {
            encoding: "jsonParsed",
            commitment: "confirmed",
            maxSupportedTransactionVersion: 0
          }]
        }),
        signal: AbortSignal.timeout(10_000)
      });
      const body: any = await res.json();
      const tx = body?.result;
      if (!tx || tx.meta?.err) return;

      // Only the wallet's own transactions count (it must be the fee payer) —
      // same airdrop/spam filter as on the EVM side.
      const feePayer = tx.transaction?.message?.accountKeys?.[0];
      const feePayerKey =
        typeof feePayer === "string" ? feePayer : feePayer?.pubkey;
      if (feePayerKey !== wallet) return;

      // Net change per mint for this wallet, from pre/post token balances.
      const deltas = new Map<string, number>();
      for (const b of tx.meta?.preTokenBalances ?? []) {
        if (b.owner !== wallet) continue;
        deltas.set(b.mint, (deltas.get(b.mint) ?? 0) - (b.uiTokenAmount?.uiAmount ?? 0));
      }
      for (const b of tx.meta?.postTokenBalances ?? []) {
        if (b.owner !== wallet) continue;
        deltas.set(b.mint, (deltas.get(b.mint) ?? 0) + (b.uiTokenAmount?.uiAmount ?? 0));
      }

      // Largest non-quote mover is the traded token.
      let best: { mint: string; delta: number } | undefined;
      for (const [mint, delta] of deltas) {
        if (QUOTE_MINTS.has(mint)) continue;
        if (Math.abs(delta) < 1e-9) continue;
        if (!best || Math.abs(delta) > Math.abs(best.delta)) best = { mint, delta };
      }
      if (!best) return;

      // Quote side: native SOL delta (fee payer is account 0, which we already
      // verified is the wallet) plus wrapped-SOL delta, or a stable delta.
      const lamportsDelta =
        (tx.meta?.postBalances?.[0] ?? 0) - (tx.meta?.preBalances?.[0] ?? 0);
      const solDelta = lamportsDelta / 1e9 + (deltas.get(WSOL_MINT) ?? 0);
      const usdDelta =
        (deltas.get("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") ?? 0) +
        (deltas.get("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB") ?? 0);
      const direction: "buy" | "sell" = best.delta > 0 ? "buy" : "sell";
      // On a buy the quote balance fell; on a sell it rose. Pick whichever
      // quote moved the most in the expected direction (SOL number includes
      // the tx fee — close enough for display).
      const sign = direction === "buy" ? -1 : 1;
      let quoteAmount: DetectedSolTrade["quoteAmount"];
      if (sign * usdDelta > Math.max(0, sign * solDelta) * 0.01 && Math.abs(usdDelta) > 0.01) {
        quoteAmount = { amount: Math.abs(usdDelta), symbol: "USDC" };
      } else if (sign * solDelta > 0.000_01) {
        quoteAmount = { amount: Math.abs(solDelta), symbol: "SOL" };
      }

      const label =
        this.store.wallets.find(w => w.address === wallet)?.label ?? "unknown";
      await this.onTrade({
        wallet,
        walletLabel: label,
        signature,
        direction,
        mint: best.mint,
        uiAmount: Math.abs(best.delta),
        quoteAmount
      });
    } catch (err: any) {
      this.onError(`[solana] failed to process ${signature}: ${err.message}`);
    }
  }
}
