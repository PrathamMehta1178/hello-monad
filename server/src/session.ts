import type { Address } from "viem";
import { publicClient, gameEconomyAbi, gameEconomyAddress } from "./chain.js";

/**
 * The Socket.io server is the trusted party for "you must have an active session to play" (spec
 * §4.1) — it listens for PlayerEntered rather than polling the chain per tick, and manages expiry
 * timers itself in memory. sessionExpiry on-chain is purely a payment record.
 */
const sessionExpiryByPlayer = new Map<string, number>();

export function recordSessionExpiry(player: Address, newExpirySeconds: bigint) {
  sessionExpiryByPlayer.set(player.toLowerCase(), Number(newExpirySeconds));
}

export function hasActiveSession(player: Address): boolean {
  const expiry = sessionExpiryByPlayer.get(player.toLowerCase());
  if (expiry === undefined) return false;
  return expiry * 1000 > Date.now();
}

export function getSessionExpiry(player: Address): number | undefined {
  return sessionExpiryByPlayer.get(player.toLowerCase());
}

/**
 * Starts the PlayerEntered event subscription. Falls back gracefully if the RPC watcher errors
 * (e.g. transient connectivity) by relying on onLogsError to just log — the server keeps running
 * on its in-memory cache rather than taking gameplay down over an RPC hiccup.
 */
export function startSessionEventListener() {
  const unwatch = publicClient.watchContractEvent({
    address: gameEconomyAddress,
    abi: gameEconomyAbi,
    eventName: "PlayerEntered",
    onLogs: (logs) => {
      for (const log of logs) {
        const args = (log as unknown as { args: { player: Address; newExpiry: bigint; amountPaid: bigint } }).args;
        if (!args?.player) continue;
        recordSessionExpiry(args.player, args.newExpiry);
        console.log(`[session] ${args.player} entered, expiry=${args.newExpiry}`);
      }
    },
    onError: (error) => {
      console.error("[session] event watcher error:", error.message);
    },
  });

  return unwatch;
}

/** One-off fallback lookup directly from chain state, used when a player connects with no cached session yet (e.g. server just restarted). */
export async function fetchSessionExpiryFromChain(player: Address): Promise<number> {
  const expiry = (await publicClient.readContract({
    address: gameEconomyAddress,
    abi: gameEconomyAbi,
    functionName: "sessionExpiry",
    args: [player],
  })) as bigint;
  recordSessionExpiry(player, expiry);
  return Number(expiry);
}
