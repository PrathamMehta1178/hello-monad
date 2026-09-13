import { createServer } from "node:http";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import { env } from "./config.js";
import { generateWorld } from "./world.js";
import { startSessionEventListener } from "./session.js";
import { refreshDiamondUnlockCache, drainPendingDiamondQueue } from "./mining.js";
import { registerSocketHandlers } from "./sockets.js";

generateWorld();

const app = express();
app.use(cors({ origin: env.CLIENT_ORIGIN }));
app.get("/health", (_req, res) => res.json({ ok: true }));

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: env.CLIENT_ORIGIN },
});

registerSocketHandlers(io);
startSessionEventListener();

// Diamond unlocks are decided purely by the contract's clock (spec §4.5) — this server never
// decides or triggers an unlock, it only periodically re-reads the current count and drains any
// mining finds that were queued while waiting for on-chain capacity to free up.
void refreshDiamondUnlockCache();
setInterval(() => void refreshDiamondUnlockCache(), 30_000);
setInterval(() => {
  void drainPendingDiamondQueue((socketId, outcome, x, z) => {
    const socket = io.sockets.sockets.get(socketId);
    if (!socket) return; // player disconnected — the voucher was still issued to their address
    if (outcome.kind === "diamondAwarded") {
      socket.emit("mine:result", { x, z, resource: "DIAMOND", amount: outcome.amount, nonce: outcome.voucher.nonce.toString() });
    }
  });
}, 15_000);

httpServer.listen(env.PORT, () => {
  console.log(`[server] listening on :${env.PORT}`);
});
