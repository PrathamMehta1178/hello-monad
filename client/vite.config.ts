import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Allows the ngrok tunnel's Host header through Vite's dev-server host check.
    allowedHosts: ["lagged-kitty-composure.ngrok-free.dev"],
    // A free ngrok plan only tunnels one port, so the Socket.io server and the local anvil RPC
    // ride through this same dev-server port instead of needing their own tunnels — see
    // chain.ts / useGameSocket.ts, which point at these paths (relative to the page's own origin)
    // whenever the configured targets are localhost.
    proxy: {
      "/socket.io": { target: "http://localhost:8080", ws: true, changeOrigin: true },
      "/rpc": { target: "http://localhost:8545", changeOrigin: true, rewrite: (path) => path.replace(/^\/rpc/, "") },
    },
  },
});
