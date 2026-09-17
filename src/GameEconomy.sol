// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {DiamondUnlock} from "./DiamondUnlock.sol";

/// @title GameEconomy
/// @notice Session entry, share-token treasury/pricing, and EIP-712 mining-claim vouchers for the
/// on-chain diamond/gold economy described in the project spec (§4). Movement, building and all
/// other gameplay stay off-chain in the authoritative Socket.io server; this contract only holds
/// the small subset of state that needs trustless, tamper-resistant guarantees: entry payments,
/// share-token ownership, and redemption pricing.
contract GameEconomy is ERC1155, Ownable, Pausable, ReentrancyGuard, EIP712 {
    // ── Resource identifiers ────────────────────────────────────────────────
    uint256 public constant DIAMOND_SHARE = 0;
    uint256 public constant GOLD_SHARE = 1;

    enum ResourceType {
        DIAMOND,
        GOLD
    }

    // ── Economic constants (spec §4.5, §8 [CONFIGURE]) ─────────────────────
    // Fixed, never change post-deploy: changing supply/unlock parameters after launch would
    // undermine the "trustless, tamper-resistant" guarantee the whole on-chain design exists for.
    uint256 public constant INITIAL_DIAMOND_UNLOCKED = 300;
    uint256 public constant TOTAL_DIAMOND_CAP = 1000;
    uint256 public constant TOTAL_GOLD_SUPPLY = 5000;

    uint256 public constant UNLOCK_FIRST_GAP_SECONDS = 1 days;
    uint256 public constant UNLOCK_GAP_INCREMENT_SECONDS = (1 days) / 5; // +0.2 days per unlock

    uint256 public constant RATE_LIMIT_WINDOW_SECONDS = 1 hours;
    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Timestamp the contract was deployed; the diamond unlock schedule is measured from here.
    uint256 public immutable genesisTimestamp;

    // ── Operational parameters (owner-tunable; hackathon-speed iteration) ──
    /// @notice Price of a game session, in wei per second.
    uint256 public pricePerSecond;
    /// @notice Share of every enterGame() payment routed to the diamond reserve, in basis points.
    uint256 public diamondReserveBps;
    /// @notice On-chain defense-in-depth rate caps, independent of what the server/off-chain
    /// signer authorized, in case the game-authority key is ever compromised (spec §5).
    uint256 public diamondClaimCapPerHour;
    uint256 public goldClaimCapPerHour;
    /// @notice Address whose signature over EIP-712 mining-claim vouchers is trusted.
    address public gameAuthority;

    // ── Treasury state ───────────────────────────────────────────────────────
    uint256 public diamondReserve;
    uint256 public goldReserve;
    uint256 public diamondRedeemed;
    uint256 public goldRedeemed;
    uint256 public diamondClaimedTotal;
    uint256 public goldClaimedTotal;

    /// @notice Session / entry contract (spec §4.1): payment record only, not gameplay-authoritative.
    mapping(address => uint256) public sessionExpiry;

    /// @notice Replay protection for claim vouchers (spec §4.2). Nonces must be globally unique
    /// across all players — the game server is responsible for allocating them that way.
    mapping(uint256 => bool) public usedNonces;

    struct RateWindow {
        uint256 windowStart;
        uint256 claimedInWindow;
    }

    mapping(ResourceType => RateWindow) private _rateWindows;

    struct Voucher {
        address player;
        ResourceType resourceType;
        uint256 amount;
        uint256 nonce;
        uint256 expiry;
    }

    bytes32 private constant VOUCHER_TYPEHASH =
        keccak256("Voucher(address player,uint8 resourceType,uint256 amount,uint256 nonce,uint256 expiry)");

    // ── Events ──────────────────────────────────────────────────────────────
    event PlayerEntered(address indexed player, uint256 newExpiry, uint256 amountPaid);
    event Claimed(address indexed player, ResourceType indexed resourceType, uint256 amount, uint256 nonce);
    event Redeemed(address indexed player, ResourceType indexed resourceType, uint256 amount, uint256 payout);
    event GameAuthorityUpdated(address indexed newGameAuthority);
    event PricePerSecondUpdated(uint256 newPricePerSecond);
    event ReserveSplitUpdated(uint256 newDiamondReserveBps);
    event ClaimCapsUpdated(uint256 newDiamondCapPerHour, uint256 newGoldCapPerHour);

    constructor(
        address initialOwner,
        address initialGameAuthority,
        uint256 initialPricePerSecond,
        uint256 initialDiamondReserveBps,
        uint256 initialDiamondClaimCapPerHour,
        uint256 initialGoldClaimCapPerHour,
        string memory uri_
    ) ERC1155(uri_) Ownable(initialOwner) EIP712("MonadGameEconomy", "1") {
        require(initialGameAuthority != address(0), "authority=0");
        require(initialDiamondReserveBps <= BPS_DENOMINATOR, "bps>10000");

        gameAuthority = initialGameAuthority;
        pricePerSecond = initialPricePerSecond;
        diamondReserveBps = initialDiamondReserveBps;
        diamondClaimCapPerHour = initialDiamondClaimCapPerHour;
        goldClaimCapPerHour = initialGoldClaimCapPerHour;

        genesisTimestamp = block.timestamp;

        // Mint the full fixed supply of each resource into the contract's own custody as
        // "unclaimed" reserve. Diamonds are gated for claiming by the unlock schedule below,
        // not by minting — the whole cap exists from genesis, just not all of it claimable yet.
        _mint(address(this), DIAMOND_SHARE, TOTAL_DIAMOND_CAP, "");
        _mint(address(this), GOLD_SHARE, TOTAL_GOLD_SUPPLY, "");
    }

    // ── §4.1 Session / entry ─────────────────────────────────────────────────

    function enterGame(uint256 durationSeconds) external payable {
        require(durationSeconds > 0, "duration=0");
        require(msg.value == pricePerSecond * durationSeconds, "wrong payment");

        uint256 base = sessionExpiry[msg.sender] > block.timestamp ? sessionExpiry[msg.sender] : block.timestamp;
        uint256 newExpiry = base + durationSeconds;
        sessionExpiry[msg.sender] = newExpiry;

        uint256 toDiamond = (msg.value * diamondReserveBps) / BPS_DENOMINATOR;
        uint256 toGold = msg.value - toDiamond;
        diamondReserve += toDiamond;
        goldReserve += toGold;

        emit PlayerEntered(msg.sender, newExpiry, msg.value);
    }

    // ── §4.5 Diamond unlock schedule (pure function of block.timestamp) ─────

    /// @notice Total diamonds unlocked (i.e. counted in outstanding supply) as of now.
    /// @dev Independently verifiable by anyone; no oracle, keeper, or trusted party decides this.
    function diamondUnlockedCount() public view returns (uint256) {
        uint256 elapsed = block.timestamp - genesisTimestamp;
        uint256 additional = DiamondUnlock.additionalUnlockedCount(
            elapsed,
            UNLOCK_FIRST_GAP_SECONDS,
            UNLOCK_GAP_INCREMENT_SECONDS,
            TOTAL_DIAMOND_CAP - INITIAL_DIAMOND_UNLOCKED
        );
        return INITIAL_DIAMOND_UNLOCKED + additional;
    }

    // ── §4.3 Treasury pricing ────────────────────────────────────────────────

    function diamondSupplyOutstanding() public view returns (uint256) {
        return diamondUnlockedCount() - diamondRedeemed;
    }

    function goldSupplyOutstanding() public view returns (uint256) {
        return TOTAL_GOLD_SUPPLY - goldRedeemed;
    }

    /// @notice Diamond price in wei, scaled by 1e18, for display purposes.
    /// @dev redeem() computes payouts directly as (amount * reserve) / supply to avoid the extra
    /// rounding step a stored/multiplied price would introduce.
    function diamondPrice() external view returns (uint256) {
        uint256 supply = diamondSupplyOutstanding();
        return supply == 0 ? 0 : (diamondReserve * 1e18) / supply;
    }

    function goldPrice() external view returns (uint256) {
        uint256 supply = goldSupplyOutstanding();
        return supply == 0 ? 0 : (goldReserve * 1e18) / supply;
    }

    // ── §4.2 Mining claim voucher ────────────────────────────────────────────

    function claim(Voucher calldata voucher, bytes calldata signature) external whenNotPaused nonReentrant {
        require(block.timestamp <= voucher.expiry, "voucher expired");
        require(!usedNonces[voucher.nonce], "nonce used");

        bytes32 structHash = keccak256(
            abi.encode(
                VOUCHER_TYPEHASH,
                voucher.player,
                uint8(voucher.resourceType),
                voucher.amount,
                voucher.nonce,
                voucher.expiry
            )
        );
        address signer = ECDSA.recover(_hashTypedDataV4(structHash), signature);
        require(signer == gameAuthority, "invalid signature");

        usedNonces[voucher.nonce] = true;
        _enforceClaimRateCap(voucher.resourceType, voucher.amount);

        uint256 tokenId;
        if (voucher.resourceType == ResourceType.DIAMOND) {
            require(diamondClaimedTotal + voucher.amount <= diamondUnlockedCount(), "exceeds unlocked diamonds");
            diamondClaimedTotal += voucher.amount;
            tokenId = DIAMOND_SHARE;
        } else {
            require(goldClaimedTotal + voucher.amount <= TOTAL_GOLD_SUPPLY, "exceeds gold supply");
            goldClaimedTotal += voucher.amount;
            tokenId = GOLD_SHARE;
        }

        // Transfers already-minted, already-counted supply out of treasury custody. Never mints,
        // never touches diamondReserve/goldReserve or *SupplyOutstanding — pricing is unaffected.
        _safeTransferFrom(address(this), voucher.player, tokenId, voucher.amount, "");

        emit Claimed(voucher.player, voucher.resourceType, voucher.amount, voucher.nonce);
    }

    function _enforceClaimRateCap(ResourceType resourceType, uint256 amount) private {
        RateWindow storage w = _rateWindows[resourceType];
        if (block.timestamp >= w.windowStart + RATE_LIMIT_WINDOW_SECONDS) {
            w.windowStart = block.timestamp;
            w.claimedInWindow = 0;
        }
        uint256 cap = resourceType == ResourceType.DIAMOND ? diamondClaimCapPerHour : goldClaimCapPerHour;
        require(w.claimedInWindow + amount <= cap, "rate cap exceeded");
        w.claimedInWindow += amount;
    }

    // ── §4.3 Redeem (sell shares back to the treasury) ───────────────────────

    function redeem(ResourceType resourceType, uint256 amount, uint256 minPayout) external nonReentrant whenNotPaused {
        require(amount > 0, "amount=0");

        uint256 tokenId = resourceType == ResourceType.DIAMOND ? DIAMOND_SHARE : GOLD_SHARE;
        uint256 supply = resourceType == ResourceType.DIAMOND ? diamondSupplyOutstanding() : goldSupplyOutstanding();
        uint256 reserve = resourceType == ResourceType.DIAMOND ? diamondReserve : goldReserve;

        require(supply > 0, "no supply");
        uint256 payout = (amount * reserve) / supply;
        require(payout >= minPayout, "slippage");

        // Effects before interaction (checks-effects-interactions), plus nonReentrant above.
        _burn(msg.sender, tokenId, amount);
        if (resourceType == ResourceType.DIAMOND) {
            diamondReserve = reserve - payout;
            diamondRedeemed += amount;
        } else {
            goldReserve = reserve - payout;
            goldRedeemed += amount;
        }

        (bool success,) = msg.sender.call{value: payout}("");
        require(success, "MON transfer failed");

        emit Redeemed(msg.sender, resourceType, amount, payout);
    }

    // ── Admin (circuit breaker + tunable operational params) ────────────────

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setGameAuthority(address newGameAuthority) external onlyOwner {
        require(newGameAuthority != address(0), "authority=0");
        gameAuthority = newGameAuthority;
        emit GameAuthorityUpdated(newGameAuthority);
    }

    function setPricePerSecond(uint256 newPricePerSecond) external onlyOwner {
        pricePerSecond = newPricePerSecond;
        emit PricePerSecondUpdated(newPricePerSecond);
    }

    function setDiamondReserveBps(uint256 newDiamondReserveBps) external onlyOwner {
        require(newDiamondReserveBps <= BPS_DENOMINATOR, "bps>10000");
        diamondReserveBps = newDiamondReserveBps;
        emit ReserveSplitUpdated(newDiamondReserveBps);
    }

    function setClaimCaps(uint256 newDiamondCapPerHour, uint256 newGoldCapPerHour) external onlyOwner {
        diamondClaimCapPerHour = newDiamondCapPerHour;
        goldClaimCapPerHour = newGoldCapPerHour;
        emit ClaimCapsUpdated(newDiamondCapPerHour, newGoldCapPerHour);
    }
}
