import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import abi from "./abi.json";
import { gameEconomyAddress } from "./chain";

const contract = { address: gameEconomyAddress, abi } as const;

export function useSessionExpiry() {
  const { address } = useAccount();
  return useReadContract({
    ...contract,
    functionName: "sessionExpiry",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 5000 },
  });
}

export function usePricePerSecond() {
  return useReadContract({ ...contract, functionName: "pricePerSecond" });
}

export function useResourcePrice(resource: "DIAMOND" | "GOLD") {
  return useReadContract({
    ...contract,
    functionName: resource === "DIAMOND" ? "diamondPrice" : "goldPrice",
    query: { refetchInterval: 10_000 },
  });
}

export function useShareBalance(resource: "DIAMOND" | "GOLD") {
  const { address } = useAccount();
  return useReadContract({
    ...contract,
    functionName: "balanceOf",
    args: address ? [address, resource === "DIAMOND" ? 0n : 1n] : undefined,
    query: { enabled: !!address, refetchInterval: 5000 },
  });
}

/**
 * Manual wallet-signed transaction — the player explicitly pays to start/extend a session (spec
 * §4.1). This is the opposite of the background claim() flow: it must never be auto-signed.
 */
export function useEnterGame() {
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });

  function enterGame(durationSeconds: bigint, cost: bigint) {
    writeContract({ ...contract, functionName: "enterGame", args: [durationSeconds], value: cost });
  }

  return { enterGame, isPending, isConfirming: receipt.isLoading, isConfirmed: receipt.isSuccess, error };
}

/**
 * Manual wallet-signed "sell" transaction (spec §4.3, §7 step 7). `minPayout` is the slippage
 * floor the player sees and approves before signing — redeem() reverts rather than silently
 * paying less.
 */
export function useRedeem() {
  const { writeContract, data: hash, isPending, error } = useWriteContract();
  const receipt = useWaitForTransactionReceipt({ hash });

  function redeem(resource: "DIAMOND" | "GOLD", amount: bigint, minPayout: bigint) {
    writeContract({
      ...contract,
      functionName: "redeem",
      args: [resource === "DIAMOND" ? 0 : 1, amount, minPayout],
    });
  }

  return { redeem, isPending, isConfirming: receipt.isLoading, isConfirmed: receipt.isSuccess, error };
}
