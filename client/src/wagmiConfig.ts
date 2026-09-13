import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { http } from "viem";
import { monadTestnet } from "./chain";

export const wagmiConfig = getDefaultConfig({
  appName: "Hello Monad",
  projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID,
  chains: [monadTestnet],
  transports: {
    [monadTestnet.id]: http(),
  },
});
