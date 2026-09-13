/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SERVER_URL: string;
  readonly VITE_GAME_ECONOMY_ADDRESS: string;
  readonly VITE_MONAD_TESTNET_CHAIN_ID: string;
  readonly VITE_MONAD_TESTNET_RPC_URL: string;
  readonly VITE_WALLETCONNECT_PROJECT_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
