import { WORLD } from "./config.js";

export const BlockType = { GRASS: 0, DIRT: 1, STONE: 2, MINED: 3 } as const;
export type BlockTypeValue = (typeof BlockType)[keyof typeof BlockType];

export const HiddenResource = { NONE: 0, GOLD: 1, DIAMOND: 2 } as const;
export type HiddenResourceValue = (typeof HiddenResource)[keyof typeof HiddenResource];

const SIZE = WORLD.SIZE;
const CELL_COUNT = SIZE * SIZE;

// Cosmetic surface layer — safe to broadcast to any client within reveal radius.
const blockType = new Uint8Array(CELL_COUNT);
// Hidden resource layer — NEVER broadcast directly. Only the mining-completion result for the
// specific tile just mined is ever revealed (spec §3.2, §5: "never send undiscovered ore
// locations to any client beyond the player's current reveal radius").
const hiddenResource = new Uint8Array(CELL_COUNT);
const mined = new Uint8Array(CELL_COUNT);

function index(x: number, z: number): number {
  return z * SIZE + x;
}

export function isWithinWorld(x: number, z: number): boolean {
  return x >= 0 && x < SIZE && z >= 0 && z < SIZE;
}

/** Deterministic PRNG so the world is reproducible across restarts given the same seed. */
function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let generated = false;

export function generateWorld(seed = 1337) {
  if (generated) return;
  const rng = mulberry32(seed);

  for (let i = 0; i < CELL_COUNT; i++) {
    const roll = rng();
    blockType[i] = roll < 0.7 ? BlockType.GRASS : roll < 0.9 ? BlockType.DIRT : BlockType.STONE;
  }

  placeUniqueResources(rng, HiddenResource.DIAMOND, WORLD.DIAMOND_TOTAL_CAP);
  placeUniqueResources(rng, HiddenResource.GOLD, WORLD.GOLD_TOTAL_SUPPLY);

  generated = true;
  console.log(`[world] generated ${SIZE}x${SIZE} world: ${WORLD.DIAMOND_TOTAL_CAP} diamond, ${WORLD.GOLD_TOTAL_SUPPLY} gold tiles buried`);
}

function placeUniqueResources(rng: () => number, resource: HiddenResourceValue, count: number) {
  let placed = 0;
  // Random retry is fine at this density (<=0.5% of 1e6 cells) — expected collisions are rare.
  while (placed < count) {
    const idx = Math.floor(rng() * CELL_COUNT);
    if (hiddenResource[idx] === HiddenResource.NONE) {
      hiddenResource[idx] = resource;
      placed++;
    }
  }
}

export function getBlockType(x: number, z: number): BlockTypeValue {
  if (mined[index(x, z)]) return BlockType.MINED;
  return blockType[index(x, z)] as BlockTypeValue;
}

export function isMined(x: number, z: number): boolean {
  return mined[index(x, z)] === 1;
}

/** Server-internal only — used exclusively by the mining resolver, never sent over the wire. */
export function peekHiddenResource(x: number, z: number): HiddenResourceValue {
  return hiddenResource[index(x, z)] as HiddenResourceValue;
}

/** Consumes the tile: marks it mined and returns whatever resource (possibly NONE) it held. */
export function mineTile(x: number, z: number): HiddenResourceValue {
  const idx = index(x, z);
  const resource = hiddenResource[idx] as HiddenResourceValue;
  mined[idx] = 1;
  hiddenResource[idx] = HiddenResource.NONE;
  return resource;
}

export interface ChunkPayload {
  cx: number;
  cz: number;
  chunkSize: number;
  // Row-major blockType values only — hiddenResource is intentionally never included.
  blocks: number[];
}

export function getChunkPayload(cx: number, cz: number): ChunkPayload | null {
  const chunksPerAxis = SIZE / WORLD.CHUNK_SIZE;
  if (cx < 0 || cz < 0 || cx >= chunksPerAxis || cz >= chunksPerAxis) return null;

  const size = WORLD.CHUNK_SIZE;
  const blocks: number[] = new Array(size * size);
  const originX = cx * size;
  const originZ = cz * size;

  for (let dz = 0; dz < size; dz++) {
    for (let dx = 0; dx < size; dx++) {
      blocks[dz * size + dx] = getBlockType(originX + dx, originZ + dz);
    }
  }

  return { cx, cz, chunkSize: size, blocks };
}

/** Chunk coordinates within reveal radius of a world position — the only chunks a client may see. */
export function chunksInRevealRadius(worldX: number, worldZ: number): Array<{ cx: number; cz: number }> {
  const chunksPerAxis = SIZE / WORLD.CHUNK_SIZE;
  const centerCx = Math.floor(worldX / WORLD.CHUNK_SIZE);
  const centerCz = Math.floor(worldZ / WORLD.CHUNK_SIZE);
  const chunkRadius = Math.ceil(WORLD.REVEAL_RADIUS_TILES / WORLD.CHUNK_SIZE);

  const result: Array<{ cx: number; cz: number }> = [];
  for (let dz = -chunkRadius; dz <= chunkRadius; dz++) {
    for (let dx = -chunkRadius; dx <= chunkRadius; dx++) {
      const cx = centerCx + dx;
      const cz = centerCz + dz;
      if (cx >= 0 && cz >= 0 && cx < chunksPerAxis && cz < chunksPerAxis) {
        result.push({ cx, cz });
      }
    }
  }
  return result;
}
