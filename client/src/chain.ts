import { defineChain } from "viem";

/**
 * When the configured target is a bare localhost URL, rewrite it to a same-origin path proxied
 * by Vite (see vite.config.ts). That lets a single ngrok tunnel (free plan: one port only) carry
 * both the page and its RPC/socket traffic to services running on the host machine — a visitor's
 * browser can't reach this machine's "localhost" directly, but it can reach the tunneled origin.
 * Against a real deployment (VITE_MONAD_TESTNET_RPC_URL pointing at an actual public RPC) this is
 * a no-op.
 */
function resolveLocalhostTarget(rawUrl: string, proxyPath: string): string {
  if (typeof window === "undefined") return rawUrl;
  const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(rawUrl);
  return isLocalhost ? `${window.location.origin}${proxyPath}` : rawUrl;
}

export const monadTestnet = defineChain({
  id: Number(import.meta.env.VITE_MONAD_TESTNET_CHAIN_ID),
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: [resolveLocalhostTarget(import.meta.env.VITE_MONAD_TESTNET_RPC_URL as string, "/rpc")] },
  },
  blockExplorers: {
    default: { name: "Monad Explorer", url: "https://testnet.monadexplorer.com" },
  },
  testnet: true,
});

export const gameEconomyAddress = import.meta.env.VITE_GAME_ECONOMY_ADDRESS as `0x${string}`;
export const serverUrl = resolveLocalhostTarget(import.meta.env.VITE_SERVER_URL as string, "");
