import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { GameCanvas } from "./game/GameCanvas";
import { Hud, EnterGamePanel } from "./Hud";
import { useGameSocket } from "./useGameSocket";
import { useSessionExpiry, usePricePerSecond, useEnterGame } from "./useGameEconomy";

export default function App() {
  const { address, isConnected } = useAccount();
  const { data: sessionExpiry, refetch: refetchSession } = useSessionExpiry();
  const { data: pricePerSecond } = usePricePerSecond();
  const { enterGame, isPending: enterPending, isConfirmed } = useEnterGame();
  const [miningTarget, setMiningTarget] = useState<{ x: number; z: number } | null>(null);

  const hasActiveSession = !!sessionExpiry && (sessionExpiry as bigint) * 1000n > BigInt(Date.now());

  const onEnter = useCallback(
    (durationSeconds: bigint, cost: bigint) => {
      enterGame(durationSeconds, cost);
    },
    [enterGame]
  );

  useEffect(() => {
    if (isConfirmed) void refetchSession();
  }, [isConfirmed, refetchSession]);

  const { socket, joined, joinError, spawn, worldSize, inventory } = useGameSocket(
    address,
    isConnected && hasActiveSession
  );

  const onMiningStateChange = useMemo(() => setMiningTarget, []);

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={{ position: "absolute", top: 12, right: 12, zIndex: 10 }}>
        <ConnectButton />
      </div>

      {isConnected && !hasActiveSession && (
        <EnterGamePanel pricePerSecond={pricePerSecond as bigint | undefined} onEnter={onEnter} isPending={enterPending} />
      )}

      {!isConnected && (
        <div style={{ position: "absolute", top: "40%", left: "50%", transform: "translate(-50%,-50%)", color: "white" }}>
          Connect your wallet to enter the game.
        </div>
      )}

      {isConnected && hasActiveSession && !joined && !joinError && (
        <div style={{ position: "absolute", top: "40%", left: "50%", transform: "translate(-50%,-50%)", color: "white" }}>
          Connecting to game server…
        </div>
      )}

      {joinError && (
        <div style={{ position: "absolute", top: "40%", left: "50%", transform: "translate(-50%,-50%)", color: "salmon" }}>
          {joinError}
        </div>
      )}

      {joined && socket && spawn && worldSize && (
        <>
          <GameCanvas socket={socket} spawn={spawn} worldSize={worldSize} onMiningStateChange={onMiningStateChange} />
          <Hud inventory={inventory} />
          {miningTarget && (
            <div style={{ position: "fixed", bottom: 60, left: "50%", transform: "translateX(-50%)", color: "white" }}>
              Mining ({miningTarget.x}, {miningTarget.z})…
            </div>
          )}
        </>
      )}
    </div>
  );
}
