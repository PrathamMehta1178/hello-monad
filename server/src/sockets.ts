import type { Server, Socket } from "socket.io";
import type { Address } from "viem";
import { MOVEMENT, WORLD } from "./config.js";
import { isWithinWorld, chunksInRevealRadius, getChunkPayload } from "./world.js";
import { hasActiveSession, fetchSessionExpiryFromChain } from "./session.js";
import { startMining, cancelMining, releaseAllLocksForSocket, type MineOutcome } from "./mining.js";

interface PlayerState {
  address: Address;
  x: number;
  z: number;
  lastMoveAt: number;
}

const players = new Map<string, PlayerState>();

function outcomeToClientPayload(outcome: MineOutcome) {
  switch (outcome.kind) {
    case "commonBlock":
      return { resource: "NONE" as const };
    case "goldAwarded":
      return { resource: "GOLD" as const, amount: outcome.amount, nonce: outcome.voucher.nonce.toString() };
    case "diamondAwarded":
      return { resource: "DIAMOND" as const, amount: outcome.amount, nonce: outcome.voucher.nonce.toString() };
    case "diamondQueued":
      return { resource: "DIAMOND_PENDING" as const };
  }
}

export function registerSocketHandlers(io: Server) {
  io.on("connection", (socket: Socket) => {
    socket.on("join", async (payload: { address: string; spawnX?: number; spawnZ?: number }) => {
      const address = payload.address as Address;
      if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
        socket.emit("join:error", { reason: "invalid address" });
        return;
      }

      let active = hasActiveSession(address);
      if (!active) {
        // Cache miss (e.g. server just restarted) — fall back to a direct chain read once.
        const expiry = await fetchSessionExpiryFromChain(address).catch(() => 0);
        active = expiry * 1000 > Date.now();
      }
      if (!active) {
        socket.emit("join:error", { reason: "no active session — call enterGame() first" });
        return;
      }

      const spawnX = clampCoord(payload.spawnX ?? WORLD.SIZE / 2);
      const spawnZ = clampCoord(payload.spawnZ ?? WORLD.SIZE / 2);
      players.set(socket.id, { address, x: spawnX, z: spawnZ, lastMoveAt: Date.now() });

      socket.emit("join:ok", { x: spawnX, z: spawnZ, worldSize: WORLD.SIZE });
      sendRevealedChunks(socket, spawnX, spawnZ);
      socket.broadcast.emit("player:joined", { id: socket.id, x: spawnX, z: spawnZ });

      // Let the newly-joined player see everyone already on the map.
      for (const [otherId, other] of players.entries()) {
        if (otherId !== socket.id) socket.emit("player:joined", { id: otherId, x: other.x, z: other.z });
      }
    });

    socket.on("move", (payload: { x: number; z: number }) => {
      const player = players.get(socket.id);
      if (!player) return;

      if (!isWithinWorld(payload.x, payload.z)) {
        socket.emit("move:correction", { x: player.x, z: player.z });
        return;
      }

      const now = Date.now();
      const dtSeconds = Math.min((now - player.lastMoveAt) / 1000, 2); // cap dt against burst abuse
      const maxDistance = MOVEMENT.MAX_SPEED_TILES_PER_SECOND * dtSeconds + MOVEMENT.MAX_POSITION_CORRECTION_TOLERANCE;
      const distance = Math.hypot(payload.x - player.x, payload.z - player.z);

      if (distance > maxDistance) {
        // Never trust client-reported position outright — reject and snap them back.
        socket.emit("move:correction", { x: player.x, z: player.z });
        return;
      }

      player.x = payload.x;
      player.z = payload.z;
      player.lastMoveAt = now;

      socket.broadcast.emit("player:moved", { id: socket.id, x: player.x, z: player.z });
      sendRevealedChunks(socket, player.x, player.z);
    });

    socket.on("mine:start", (payload: { x: number; z: number }) => {
      const player = players.get(socket.id);
      if (!player) return;

      const result = startMining(socket.id, player.address, player.x, player.z, payload.x, payload.z, {
        onOutcome: (outcome, x, z) => {
          socket.emit("mine:result", { x, z, ...outcomeToClientPayload(outcome) });
        },
        onBroadcastMined: (x, z) => {
          io.emit("block:mined", { x, z });
        },
      });

      if (!result.ok) {
        socket.emit("mine:rejected", { x: payload.x, z: payload.z, reason: result.reason });
      } else {
        socket.emit("mine:started", { x: payload.x, z: payload.z });
      }
    });

    socket.on("mine:cancel", (payload: { x: number; z: number }) => {
      cancelMining(socket.id, payload.x, payload.z);
    });

    socket.on("disconnect", () => {
      releaseAllLocksForSocket(socket.id);
      players.delete(socket.id);
      socket.broadcast.emit("player:left", { id: socket.id });
    });
  });
}

/** Exposed so index.ts's diamond-queue drain ticker can push results to a specific reconnecting player. */
export function findSocketIdForAddress(address: Address): string | undefined {
  for (const [socketId, player] of players.entries()) {
    if (player.address.toLowerCase() === address.toLowerCase()) return socketId;
  }
  return undefined;
}

function clampCoord(v: number): number {
  return Math.max(0, Math.min(WORLD.SIZE - 1, Math.floor(v)));
}

function sendRevealedChunks(socket: Socket, x: number, z: number) {
  for (const { cx, cz } of chunksInRevealRadius(x, z)) {
    const chunk = getChunkPayload(cx, cz);
    if (chunk) socket.emit("chunk", chunk);
  }
}
