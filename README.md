# Hello Monad

An on-chain Minecraft-style multiplayer game on Monad testnet. Movement and building happen in
real time over a socket connection; diamonds and gold are ERC-1155 shares in a treasury funded by
player entry fees, redeemable for MON at a price that only ever rises from new entrants.

**Core principle: the blockchain never sits in the critical path of gameplay.** Movement, building
and mining are validated by an authoritative Socket.io server in real time. The chain only holds
entry payments, share-token ownership, and the diamond unlock schedule — see `contracts/GameEconomy.sol`.

## Layout

- `src/`, `test/`, `script/` — Foundry project: `GameEconomy.sol` (treasury, pricing, EIP-712
  mining-claim vouchers, diamond unlock schedule) and `DiamondUnlock.sol` (pure unlock-schedule math).
- `server/` — Socket.io game server: world state, movement/mining validation, tile locking,
  reveal-radius anti-x-ray, session tracking via `PlayerEntered` events, voucher signing, and
  background claim-transaction relaying.
- `client/` — React + Vite + Three.js browser client: wallet connect (RainbowKit/wagmi), a
  first-person voxel-ish view of the world, WASD movement with client-side prediction, mining, and
  manual "Enter Game" / "Sell" transactions.

## Contracts

```shell
forge install        # first time only
forge build
forge test            # 36 tests: unlock schedule fuzzing, entry/pricing, vouchers, reentrancy
```

Deploy (see script/Deploy.s.sol for the [CONFIGURE] defaults — reserve split, claim rate caps,
entry price — all owner-tunable post-deploy):

```shell
export GAME_AUTHORITY_ADDRESS=0x...   # the server's game-authority signer address
forge script script/Deploy.s.sol:Deploy --rpc-url monad_testnet --broadcast --private-key $DEPLOYER_KEY
```

## Server

```shell
cd server
cp .env.example .env   # fill in GAME_ECONOMY_ADDRESS, GAME_AUTHORITY_PRIVATE_KEY, RELAYER_PRIVATE_KEY
npm install
npm run dev
```

Two-key separation (spec §5): `GAME_AUTHORITY_PRIVATE_KEY` only ever signs EIP-712 vouchers and
never broadcasts a transaction; `RELAYER_PRIVATE_KEY` only ever pays gas to broadcast the claim()
transactions those vouchers authorize. In production the game-authority key belongs in a KMS/HSM,
not a plaintext env var — this repo's `.env` approach is a hackathon-speed stand-in.

## Client

```shell
cd client
cp .env.example .env.local   # fill in VITE_GAME_ECONOMY_ADDRESS and RPC/WalletConnect details
npm install
npm run dev
```

Claiming a mined resource is auto-signed by the server's relayer in the background — players never
sign anything for routine mining. They do sign manually for `enterGame` (pay to play) and the
voluntary `redeem` ("sell", with slippage protection surfaced in the UI).

## Known simplifications (hackathon scope)

- The world is modeled as flat 2D tiles (x, z) rather than full voxel columns with height/Y mining.
- Non-valuable inventory (dirt/stone) is tracked client-side per session rather than persisted
  server-side across reconnects.
- Bot/farming detection, Sybil resistance on entry fees, and fraud-proof movement verification are
  explicitly out of scope (see project spec §6).
