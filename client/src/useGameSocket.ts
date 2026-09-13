import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { serverUrl } from "./chain";

export interface Inventory {
  dirt: number;
  stone: number;
  gold: number;
  diamond: number;
  pendingDiamond: number;
}

export interface GameConnectionState {
  socket: Socket | null;
  connected: boolean;
  joined: boolean;
  joinError: string | null;
  spawn: { x: number; z: number } | null;
  worldSize: number | null;
  inventory: Inventory;
}

/**
 * Owns the Socket.io connection to the authoritative game server (spec §3.2). Movement, building
 * and mining are validated server-side and never touch the chain directly — only the resulting
 * mining-claim vouchers do, and that happens in the background (see chain.ts's broadcastClaim
 * equivalent on the server; the client never signs anything for routine mining).
 */
export function useGameSocket(playerAddress: `0x${string}` | undefined, active: boolean): GameConnectionState {
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);
  const [joined, setJoined] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [spawn, setSpawn] = useState<{ x: number; z: number } | null>(null);
  const [worldSize, setWorldSize] = useState<number | null>(null);
  const [inventory, setInventory] = useState<Inventory>({ dirt: 0, stone: 0, gold: 0, diamond: 0, pendingDiamond: 0 });

  useEffect(() => {
    if (!active || !playerAddress) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      setConnected(false);
      setJoined(false);
      setSpawn(null);
      return;
    }

    const socket = io(serverUrl, { transports: ["websocket"] });
    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
      socket.emit("join", { address: playerAddress });
    });
    socket.on("disconnect", () => {
      setConnected(false);
      setJoined(false);
    });
    socket.on("join:ok", (payload: { x: number; z: number; worldSize: number }) => {
      setJoined(true);
      setJoinError(null);
      setSpawn({ x: payload.x, z: payload.z });
      setWorldSize(payload.worldSize);
    });
    socket.on("join:error", (payload: { reason: string }) => {
      setJoined(false);
      setJoinError(payload.reason);
    });
    socket.on("mine:result", (payload: { resource: string; amount?: number }) => {
      setInventory((inv) => {
        switch (payload.resource) {
          case "GOLD":
            return { ...inv, gold: inv.gold + (payload.amount ?? 1) };
          case "DIAMOND":
            return { ...inv, diamond: inv.diamond + (payload.amount ?? 1) };
          case "DIAMOND_PENDING":
            return { ...inv, pendingDiamond: inv.pendingDiamond + 1 };
          case "NONE":
          default:
            return inv;
        }
      });
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, playerAddress]);

  return { socket: socketRef.current, connected, joined, joinError, spawn, worldSize, inventory };
}
