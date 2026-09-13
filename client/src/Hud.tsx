import { useState } from "react";
import { formatEther } from "viem";
import type { Inventory } from "./useGameSocket";
import { useResourcePrice, useShareBalance, useRedeem } from "./useGameEconomy";

const SLIPPAGE_BPS = 300n; // 3% default slippage tolerance for the "sell" UI [CONFIGURE]

function SellPanel({ resource }: { resource: "DIAMOND" | "GOLD" }) {
  const [amount, setAmount] = useState("1");
  const { data: price } = useResourcePrice(resource); // wei per share, scaled 1e18
  const { data: balance } = useShareBalance(resource);
  const { redeem, isPending, isConfirming, isConfirmed, error } = useRedeem();

  const amountBig = (() => {
    try {
      return BigInt(amount || "0");
    } catch {
      return 0n;
    }
  })();

  const expectedPayout = price ? (amountBig * (price as bigint)) / 10n ** 18n : 0n;
  const minPayout = expectedPayout - (expectedPayout * SLIPPAGE_BPS) / 10_000n;

  return (
    <div style={panelStyle}>
      <strong>{resource}</strong>
      <div>Balance: {balance?.toString() ?? "—"}</div>
      <div>Price: {price ? `${formatEther(price as bigint)} MON` : "—"}</div>
      <input
        type="number"
        min={0}
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        style={{ width: 70 }}
      />
      <div>Est. payout: {formatEther(expectedPayout)} MON (min {formatEther(minPayout)})</div>
      <button
        disabled={amountBig <= 0n || isPending || isConfirming}
        onClick={() => redeem(resource, amountBig, minPayout)}
      >
        {isPending || isConfirming ? "Selling…" : "Sell"}
      </button>
      {isConfirmed && <div style={{ color: "lightgreen" }}>Sold!</div>}
      {error && <div style={{ color: "salmon" }}>{error.message.slice(0, 120)}</div>}
    </div>
  );
}

export function Hud({ inventory }: { inventory: Inventory }) {
  return (
    <div style={{ position: "absolute", top: 12, left: 12, right: 12, pointerEvents: "none" }}>
      <div style={{ ...panelStyle, pointerEvents: "auto" }}>
        <strong>Inventory</strong>
        <div>Dirt: {inventory.dirt}</div>
        <div>Stone: {inventory.stone}</div>
        <div>Gold: {inventory.gold}</div>
        <div>Diamond: {inventory.diamond}</div>
        {inventory.pendingDiamond > 0 && (
          <div style={{ opacity: 0.7 }}>Diamond (awaiting unlock): {inventory.pendingDiamond}</div>
        )}
      </div>
      <div style={{ position: "absolute", top: 0, right: 0, pointerEvents: "auto", display: "flex", gap: 8 }}>
        <SellPanel resource="GOLD" />
        <SellPanel resource="DIAMOND" />
      </div>
      <div style={{ position: "fixed", bottom: 16, left: "50%", transform: "translateX(-50%)", color: "white" }}>
        WASD to move · click to lock mouse · hold left click on a block to mine
      </div>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  background: "rgba(0,0,0,0.6)",
  color: "white",
  padding: "8px 12px",
  borderRadius: 8,
  fontFamily: "monospace",
  fontSize: 13,
  minWidth: 140,
};

export function EnterGamePanel({
  pricePerSecond,
  onEnter,
  isPending,
}: {
  pricePerSecond: bigint | undefined;
  onEnter: (durationSeconds: bigint, cost: bigint) => void;
  isPending: boolean;
}) {
  const [minutes, setMinutes] = useState("60");
  const durationSeconds = BigInt(Math.max(0, Math.floor(Number(minutes) * 60)) || 0);
  const cost = pricePerSecond ? pricePerSecond * durationSeconds : 0n;

  return (
    <div style={{ ...panelStyle, position: "absolute", top: "40%", left: "50%", transform: "translate(-50%, -50%)" }}>
      <strong>Enter Game</strong>
      <div>
        Minutes: <input type="number" min={1} value={minutes} onChange={(e) => setMinutes(e.target.value)} style={{ width: 60 }} />
      </div>
      <div>Cost: {pricePerSecond !== undefined ? `${formatEther(cost)} MON` : "—"}</div>
      <button disabled={isPending || durationSeconds <= 0n} onClick={() => onEnter(durationSeconds, cost)}>
        {isPending ? "Confirming…" : "Pay & Enter"}
      </button>
    </div>
  );
}
