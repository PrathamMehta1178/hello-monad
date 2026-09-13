import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createPublicClient, createWalletClient, http, defineChain, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env, VOUCHER } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const gameEconomyAbi = JSON.parse(
  readFileSync(path.join(__dirname, "abi", "GameEconomy.json"), "utf8")
);

export const monadTestnet = defineChain({
  id: env.MONAD_TESTNET_CHAIN_ID,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [env.MONAD_TESTNET_RPC_URL] } },
});

export const gameEconomyAddress = env.GAME_ECONOMY_ADDRESS as Address;

export const publicClient = createPublicClient({
  chain: monadTestnet,
  transport: http(),
});

/**
 * Low-privilege relayer: pays gas to broadcast batched/relayed transactions only (spec §3.2, §5).
 * It never signs vouchers and authorizes nothing on its own — losing this key costs only gas
 * money, never game-economy integrity.
 */
const relayerAccount = privateKeyToAccount(env.RELAYER_PRIVATE_KEY as Hex);
export const relayerWalletClient = createWalletClient({
  account: relayerAccount,
  chain: monadTestnet,
  transport: http(),
});

/**
 * High-privilege game-authority signer: signs EIP-712 mining-claim vouchers only. It never
 * broadcasts a transaction or spends gas itself — treat its private key as the single most
 * sensitive secret in the system (spec §3.2, §5). In production, replace `privateKeyToAccount`
 * here with a KMS/HSM-backed signer behind the same `signTypedData` interface.
 */
const gameAuthorityAccount = privateKeyToAccount(env.GAME_AUTHORITY_PRIVATE_KEY as Hex);

export const ResourceType = { DIAMOND: 0, GOLD: 1 } as const;
export type ResourceTypeValue = (typeof ResourceType)[keyof typeof ResourceType];

export interface Voucher {
  player: Address;
  resourceType: ResourceTypeValue;
  amount: bigint;
  nonce: bigint;
  expiry: bigint;
}

const eip712Domain = {
  name: "MonadGameEconomy",
  version: "1",
  chainId: env.MONAD_TESTNET_CHAIN_ID,
  verifyingContract: gameEconomyAddress,
} as const;

const voucherTypes = {
  Voucher: [
    { name: "player", type: "address" },
    { name: "resourceType", type: "uint8" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
  ],
} as const;

let nonceCounter = BigInt(Date.now()) * 1_000_000n;

/** Allocates a globally-unique voucher nonce. The contract's replay protection assumes this. */
export function nextNonce(): bigint {
  nonceCounter += 1n;
  return nonceCounter;
}

export async function signMiningVoucher(player: Address, resourceType: ResourceTypeValue, amount: bigint): Promise<{
  voucher: Voucher;
  signature: Hex;
}> {
  const voucher: Voucher = {
    player,
    resourceType,
    amount,
    nonce: nextNonce(),
    expiry: BigInt(Math.floor(Date.now() / 1000) + VOUCHER.EXPIRY_SECONDS),
  };

  const signature = await gameAuthorityAccount.signTypedData({
    domain: eip712Domain,
    types: voucherTypes,
    primaryType: "Voucher",
    message: voucher,
  });

  return { voucher, signature };
}

/**
 * Background claim submission (spec §4.2, §8): the relayer broadcasts the claim transaction on
 * the player's behalf so routine mining never requires a manual wallet signature. Auto-signed via
 * this server-held relayer flow, per the [CONFIGURE] UX decision in spec §8 — the player only
 * signs manually for `enterGame` and the voluntary `redeem` ("sell").
 */
export async function broadcastClaim(voucher: Voucher, signature: Hex): Promise<Hex> {
  return relayerWalletClient.writeContract({
    address: gameEconomyAddress,
    abi: gameEconomyAbi,
    functionName: "claim",
    args: [voucher, signature],
  });
}

export async function readDiamondUnlockedCount(): Promise<bigint> {
  return publicClient.readContract({
    address: gameEconomyAddress,
    abi: gameEconomyAbi,
    functionName: "diamondUnlockedCount",
  }) as Promise<bigint>;
}
