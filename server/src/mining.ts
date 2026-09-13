import type { Address } from "viem";
import { MINING, WORLD } from "./config.js";
import { HiddenResource, type HiddenResourceValue, BlockType, isWithinWorld, isMined, getBlockType, mineTile } from "./world.js";
import { ResourceType, broadcastClaim, readDiamondUnlockedCount, signMiningVoucher, type Voucher } from "./chain.js";

interface TileLock {
  socketId: string;
  startedAt: number;
  timeout: ReturnType<typeof setTimeout>;
}

const tileKey = (x: number, z: number) => `${x}:${z}`;

/** Authoritative lock on any tile being mined, preventing two players from both "winning" it (spec §3.2, §5). */
const tileLocks = new Map<string, TileLock>();

interface PendingDiamond {
  player: Address;
  socketId: string;
  x: number;
  z: number;
}

/**
 * Diamonds physically exist in the buried world from genesis, but the *claimable* count is gated
 * by the on-chain unlock schedule (spec §4.5). A player can mine a not-yet-unlocked diamond tile —
 * it just queues for a voucher once on-chain capacity frees up, instead of vanishing.
 */
const pendingDiamondQueue: PendingDiamond[] = [];
let diamondsAwardedSoFar = 0;
let goldAwardedSoFar = 0;
let cachedDiamondUnlockedCount = 0;

export async function refreshDiamondUnlockCache() {
  try {
    cachedDiamondUnlockedCount = Number(await readDiamondUnlockedCount());
  } catch (err) {
    console.error("[mining] failed to refresh diamond unlock count:", (err as Error).message);
  }
}

export type MineOutcome =
  | { kind: "commonBlock"; blockType: number }
  | { kind: "goldAwarded"; amount: number; voucher: Voucher; signature: `0x${string}` }
  | { kind: "diamondQueued" }
  | { kind: "diamondAwarded"; amount: number; voucher: Voucher; signature: `0x${string}` };

export interface MineHandlers {
  onOutcome: (outcome: MineOutcome, x: number, z: number) => void;
  onBroadcastMined: (x: number, z: number) => void;
}

function durationForBlock(blockType: number): number {
  switch (blockType) {
    case BlockType.STONE:
      return MINING.STONE_MS;
    default:
      return MINING.DIRT_MS;
  }
}

export function isAdjacent(playerX: number, playerZ: number, targetX: number, targetZ: number): boolean {
  const dx = Math.abs(playerX - targetX);
  const dz = Math.abs(playerZ - targetZ);
  return dx <= MINING.MAX_ADJACENT_DISTANCE_TILES && dz <= MINING.MAX_ADJACENT_DISTANCE_TILES;
}

export function startMining(
  socketId: string,
  playerAddress: Address,
  playerX: number,
  playerZ: number,
  targetX: number,
  targetZ: number,
  handlers: MineHandlers
): { ok: true } | { ok: false; reason: string } {
  if (!isWithinWorld(targetX, targetZ)) return { ok: false, reason: "out of bounds" };
  if (isMined(targetX, targetZ)) return { ok: false, reason: "already mined" };
  if (!isAdjacent(playerX, playerZ, targetX, targetZ)) return { ok: false, reason: "not adjacent" };

  const key = tileKey(targetX, targetZ);
  const existing = tileLocks.get(key);
  if (existing) {
    // Never trust a lock forever — a disconnected miner shouldn't permanently block a tile.
    if (Date.now() - existing.startedAt < MINING.TILE_LOCK_TIMEOUT_MS) {
      return { ok: false, reason: "tile locked by another player" };
    }
    clearTimeout(existing.timeout);
    tileLocks.delete(key);
  }

  const blockType = getBlockType(targetX, targetZ);
  const duration = durationForBlock(blockType);

  const timeout = setTimeout(() => {
    void resolveMining(key, targetX, targetZ, socketId, playerAddress, handlers);
  }, duration);

  tileLocks.set(key, { socketId, startedAt: Date.now(), timeout });
  return { ok: true };
}

export function cancelMining(socketId: string, targetX: number, targetZ: number) {
  const key = tileKey(targetX, targetZ);
  const lock = tileLocks.get(key);
  if (lock && lock.socketId === socketId) {
    clearTimeout(lock.timeout);
    tileLocks.delete(key);
  }
}

export function releaseAllLocksForSocket(socketId: string) {
  for (const [key, lock] of tileLocks.entries()) {
    if (lock.socketId === socketId) {
      clearTimeout(lock.timeout);
      tileLocks.delete(key);
    }
  }
}

async function resolveMining(
  key: string,
  x: number,
  z: number,
  socketId: string,
  playerAddress: Address,
  handlers: MineHandlers
) {
  const lock = tileLocks.get(key);
  // Lock must still be held by the same socket — guards against a cancel/disconnect race.
  if (!lock || lock.socketId !== socketId) return;
  tileLocks.delete(key);

  const blockTypeBefore = getBlockType(x, z);
  const resource: HiddenResourceValue = mineTile(x, z);
  handlers.onBroadcastMined(x, z);

  if (resource === HiddenResource.NONE) {
    handlers.onOutcome({ kind: "commonBlock", blockType: blockTypeBefore }, x, z);
    return;
  }

  if (resource === HiddenResource.GOLD) {
    if (goldAwardedSoFar >= WORLD.GOLD_TOTAL_SUPPLY) return; // should be unreachable given finite gold tiles
    goldAwardedSoFar += 1;
    const { voucher, signature } = await signMiningVoucher(playerAddress, ResourceType.GOLD, 1n);
    handlers.onOutcome({ kind: "goldAwarded", amount: 1, voucher, signature }, x, z);
    void broadcastClaim(voucher, signature).catch((err) =>
      console.error(`[mining] background gold claim broadcast failed for ${playerAddress}:`, err.message)
    );
    return;
  }

  // DIAMOND
  if (diamondsAwardedSoFar < cachedDiamondUnlockedCount) {
    diamondsAwardedSoFar += 1;
    const { voucher, signature } = await signMiningVoucher(playerAddress, ResourceType.DIAMOND, 1n);
    handlers.onOutcome({ kind: "diamondAwarded", amount: 1, voucher, signature }, x, z);
    void broadcastClaim(voucher, signature).catch((err) =>
      console.error(`[mining] background diamond claim broadcast failed for ${playerAddress}:`, err.message)
    );
  } else {
    pendingDiamondQueue.push({ player: playerAddress, socketId, x, z });
    handlers.onOutcome({ kind: "diamondQueued" }, x, z);
  }
}

/**
 * Drains queued diamond finds once more on-chain unlock capacity is available. Call periodically
 * (see index.ts) — capacity only ever grows, decided purely by the contract's own clock (spec §4.5).
 */
export async function drainPendingDiamondQueue(
  notify: (socketId: string, outcome: MineOutcome, x: number, z: number) => void
) {
  await refreshDiamondUnlockCache();
  while (pendingDiamondQueue.length > 0 && diamondsAwardedSoFar < cachedDiamondUnlockedCount) {
    const next = pendingDiamondQueue.shift()!;
    diamondsAwardedSoFar += 1;
    const { voucher, signature } = await signMiningVoucher(next.player, ResourceType.DIAMOND, 1n);
    notify(next.socketId, { kind: "diamondAwarded", amount: 1, voucher, signature }, next.x, next.z);
    void broadcastClaim(voucher, signature).catch((err) =>
      console.error(`[mining] background diamond claim broadcast failed for ${next.player}:`, err.message)
    );
  }
}
