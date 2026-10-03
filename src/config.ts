import "dotenv/config";
import { base, bsc, mainnet } from "viem/chains";
import type { Address, Chain } from "viem";

export type NetworkKey = "base" | "ethereum" | "bsc";

export interface StableCoin {
  address: Address;
  decimals: number;
  symbol: string;
}

export interface NetworkConfig {
  key: NetworkKey;
  chain: Chain;
  /** undefined when the env var for this network is not set — network unavailable */
  wsUrl?: string;
  /** wrapped native token (WETH / WBNB) */
  weth: Address;
  /** native coin ticker for display */
  nativeSymbol: string;
  /** Uniswap V3 SwapRouter02 */
  swapRouter: Address;
  /** Uniswap V3 QuoterV2 */
  quoter: Address;
  /** Uniswap V2 (or fork) Router02 — many tokens still launch on V2 pools */
  v2Router?: Address;
  /** Aerodrome (Velodrome/Solidly-style) Router — most Base memecoins live here */
  aerodromeRouter?: Address;
  /** Aerodrome default PoolFactory (passed in each route hop) */
  aerodromeFactory?: Address;
  /** stablecoins whose Transfer legs mark a tx as a real swap */
  stables: StableCoin[];
  /** optional non-native quote asset usable for trading (e.g. USDC on Base) */
  usdc?: { address: Address; decimals: number };
  explorer: string;
  /** DexScreener chain slug */
  dsSlug: string;
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const optionalEnv = (name: string): string | undefined =>
  process.env[name] || undefined;

export const NETWORKS: Record<NetworkKey, NetworkConfig> = {
  base: {
    key: "base",
    chain: base,
    wsUrl: env("BASE_WS_URL"),
    weth: "0x4200000000000000000000000000000000000006",
    nativeSymbol: "ETH",
    swapRouter: "0x2626664c2603336E57B271c5C0b26F421741e481",
    quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    v2Router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24", // Uniswap V2 Router02 on Base
    aerodromeRouter: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43", // Aerodrome Router (Base) — verified live
    aerodromeFactory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da", // Aerodrome default PoolFactory
    stables: [
      { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6, symbol: "USDC" },
      { address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", decimals: 6, symbol: "USDbC" },
      { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", decimals: 18, symbol: "DAI" }
    ],
    usdc: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
    explorer: "https://basescan.org",
    dsSlug: "base"
  },
  ethereum: {
    key: "ethereum",
    chain: mainnet,
    wsUrl: env("ETH_WS_URL"),
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    nativeSymbol: "ETH",
    swapRouter: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    v2Router: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D", // Uniswap V2 Router02 on Ethereum
    stables: [
      { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6, symbol: "USDC" },
      { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, symbol: "USDT" },
      { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", decimals: 18, symbol: "DAI" }
    ],
    explorer: "https://etherscan.io",
    dsSlug: "ethereum"
  },
  bsc: {
    key: "bsc",
    chain: bsc,
    wsUrl: optionalEnv("BNB_WS_URL"),
    weth: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
    nativeSymbol: "BNB",
    swapRouter: "0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2",
    quoter: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077",
    v2Router: "0x10ED43C718714eb63d5aA57B78B54704E256024E", // PancakeSwap V2 Router (V2-compatible) on BSC
    stables: [
      // BSC peg tokens use 18 decimals, unlike their mainnet counterparts
      { address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18, symbol: "USDT" },
      { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18, symbol: "USDC" },
      { address: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56", decimals: 18, symbol: "BUSD" }
    ],
    usdc: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 }, // BSC USDC (18 dec)
    explorer: "https://bscscan.com",
    dsSlug: "bsc"
  }
};

/** Networks that can actually run (their RPC env var is set). */
export const availableNetworks = (): NetworkConfig[] =>
  Object.values(NETWORKS).filter(n => !!n.wsUrl);

export const SOLANA = {
  /** watch-only for now; trading comes in a later phase */
  wsUrl: optionalEnv("SOLANA_WS_URL") ?? "wss://api.mainnet-beta.solana.com",
  rpcUrl: optionalEnv("SOLANA_RPC_URL") ?? "https://api.mainnet-beta.solana.com",
  privateKey: optionalEnv("SOLANA_PRIVATE_KEY"),
  jupiterApiKey: optionalEnv("JUPITER_API_KEY"),
  explorer: "https://solscan.io",
  dsSlug: "solana"
};

export const APP = {
  telegramToken: env("TELEGRAM_BOT_TOKEN"),
  scoutTelegramToken: optionalEnv("SCOUT_TELEGRAM_BOT_TOKEN"),
  adminId: Number(env("TELEGRAM_ADMIN_ID")),
  privateKey: env("PRIVATE_KEY") as `0x${string}`
};
