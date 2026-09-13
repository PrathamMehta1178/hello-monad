import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  MONAD_TESTNET_RPC_URL: z.string().url(),
  MONAD_TESTNET_CHAIN_ID: z.coerce.number().int().positive(),
  GAME_ECONOMY_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  GAME_AUTHORITY_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  RELAYER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  PORT: z.coerce.number().int().positive().default(8080),
  CLIENT_ORIGIN: z.string().default("http://localhost:5173"),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid server environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

/**
 * Named, tunable constants for the parts of the spec marked [CONFIGURE]. These govern only
 * off-chain (server/world) behavior — the on-chain economic constants (supply caps, unlock
 * schedule, reserve split) live in the contract itself and are not duplicated here except where
 * the server needs to mirror them for local bookkeeping (see WORLD.GOLD_TOTAL_SUPPLY below,
 * which must match GameEconomy.TOTAL_GOLD_SUPPLY).
 */
export const WORLD = {
  SIZE: 1000, // 1000x1000 world, per spec §3.2
  CHUNK_SIZE: 25, // world is divided into 40x40 chunks of 25x25 tiles for reveal batching
  REVEAL_RADIUS_TILES: 40, // anti-x-ray: only send chunks within this radius of the player
  GOLD_TOTAL_SUPPLY: 5000, // must match GameEconomy.TOTAL_GOLD_SUPPLY
  DIAMOND_TOTAL_CAP: 1000, // must match GameEconomy.TOTAL_DIAMOND_CAP
} as const;

export const MOVEMENT = {
  MAX_SPEED_TILES_PER_SECOND: 6,
  // How far a client-reported position may drift from server dead-reckoning before we snap-correct.
  MAX_POSITION_CORRECTION_TOLERANCE: 1.5,
} as const;

export const MINING = {
  DIRT_MS: 400,
  STONE_MS: 900,
  GOLD_MS: 2000,
  DIAMOND_MS: 3500,
  MAX_ADJACENT_DISTANCE_TILES: 2, // player must be within this many tiles of the block mined
  TILE_LOCK_TIMEOUT_MS: 10_000, // stale lock auto-release if a mining player disconnects mid-mine
} as const;

export const VOUCHER = {
  EXPIRY_SECONDS: 10 * 60, // claim vouchers are valid for 10 minutes after signing
} as const;
