// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {GameEconomy} from "../src/GameEconomy.sol";
import {IERC1155Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

contract GameEconomyTest is Test {
    GameEconomy econ;

    address owner = makeAddr("owner");
    uint256 authorityKey = 0xA11CE;
    address authority;
    address relayer = makeAddr("relayer");
    address player = makeAddr("player");
    address player2 = makeAddr("player2");

    uint256 constant PRICE_PER_SECOND = 1e12; // ~0.0036 MON/hour
    uint256 constant DIAMOND_BPS = 7000; // 70/30 split (spec example)
    uint256 constant DIAMOND_CAP_PER_HOUR = 1000;
    uint256 constant GOLD_CAP_PER_HOUR = 500;

    function setUp() public {
        authority = vm.addr(authorityKey);
        econ = new GameEconomy(
            owner, authority, PRICE_PER_SECOND, DIAMOND_BPS, DIAMOND_CAP_PER_HOUR, GOLD_CAP_PER_HOUR, "ipfs://metadata/"
        );
        vm.deal(player, 100 ether);
        vm.deal(player2, 100 ether);
    }

    // ── Helpers ───────────────────────────────────────────────────────────

    function _sign(GameEconomy.Voucher memory v) internal view returns (bytes memory) {
        bytes32 typeHash =
            keccak256("Voucher(address player,uint8 resourceType,uint256 amount,uint256 nonce,uint256 expiry)");
        bytes32 structHash =
            keccak256(abi.encode(typeHash, v.player, uint8(v.resourceType), v.amount, v.nonce, v.expiry));
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("MonadGameEconomy")),
                keccak256(bytes("1")),
                block.chainid,
                address(econ)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v_, bytes32 r, bytes32 s) = vm.sign(authorityKey, digest);
        return abi.encodePacked(r, s, v_);
    }

    function _voucher(address to, GameEconomy.ResourceType rt, uint256 amount, uint256 nonce)
        internal
        view
        returns (GameEconomy.Voucher memory)
    {
        return GameEconomy.Voucher({
            player: to,
            resourceType: rt,
            amount: amount,
            nonce: nonce,
            expiry: block.timestamp + 1 hours
        });
    }

    function _claim(address to, GameEconomy.ResourceType rt, uint256 amount, uint256 nonce) internal {
        GameEconomy.Voucher memory v = _voucher(to, rt, amount, nonce);
        vm.prank(relayer);
        econ.claim(v, _sign(v));
    }

    // ── §4.1 enterGame ────────────────────────────────────────────────────

    function test_enterGame_setsExpiryAndSplitsReserves() public {
        uint256 duration = 3600;
        uint256 cost = PRICE_PER_SECOND * duration;

        vm.prank(player);
        vm.expectEmit(true, false, false, true);
        emit GameEconomy.PlayerEntered(player, block.timestamp + duration, cost);
        econ.enterGame{value: cost}(duration);

        assertEq(econ.sessionExpiry(player), block.timestamp + duration);
        assertEq(econ.diamondReserve(), (cost * DIAMOND_BPS) / 10_000);
        assertEq(econ.goldReserve(), cost - (cost * DIAMOND_BPS) / 10_000);
    }

    function test_enterGame_extendsRatherThanOverwritesUnexpiredSession() public {
        uint256 duration = 3600;
        uint256 cost = PRICE_PER_SECOND * duration;

        vm.startPrank(player);
        econ.enterGame{value: cost}(duration);
        uint256 firstExpiry = econ.sessionExpiry(player);

        econ.enterGame{value: cost}(duration);
        vm.stopPrank();

        assertEq(econ.sessionExpiry(player), firstExpiry + duration);
    }

    function test_enterGame_afterExpiryStartsFromNow() public {
        uint256 duration = 3600;
        uint256 cost = PRICE_PER_SECOND * duration;

        vm.prank(player);
        econ.enterGame{value: cost}(duration);

        vm.warp(block.timestamp + duration + 1 days);

        vm.prank(player);
        econ.enterGame{value: cost}(duration);

        assertEq(econ.sessionExpiry(player), block.timestamp + duration);
    }

    function test_enterGame_revertsOnWrongPayment() public {
        vm.prank(player);
        vm.expectRevert(bytes("wrong payment"));
        econ.enterGame{value: 1}(3600);
    }

    // ── §4.5 unlock schedule wired to the contract's genesis ────────────────

    function test_diamondUnlockedCount_startsAtInitial() public view {
        assertEq(econ.diamondUnlockedCount(), 300);
    }

    function test_diamondUnlockedCount_growsOverTime() public {
        vm.warp(block.timestamp + 1 days);
        assertEq(econ.diamondUnlockedCount(), 301);
    }

    // ── §4.3 pricing invariants ──────────────────────────────────────────────

    function test_price_risesWhenNewEntrantAddsReserveAtFixedSupply() public {
        // Gold has no unlock schedule, so its outstanding supply is fixed at genesis — isolates
        // the "price only rises from new entrants" behavior from the diamond unlock schedule.
        uint256 duration = 1000;
        uint256 cost = PRICE_PER_SECOND * duration;

        vm.prank(player);
        econ.enterGame{value: cost}(duration);
        uint256 priceBefore = econ.goldPrice();

        vm.prank(player2);
        econ.enterGame{value: cost}(duration);
        uint256 priceAfter = econ.goldPrice();

        assertGt(priceAfter, priceBefore);
    }

    function test_price_neverFallsWhenSomeoneSells() public {
        uint256 duration = 1000;
        uint256 cost = PRICE_PER_SECOND * duration;
        vm.prank(player);
        econ.enterGame{value: cost}(duration);

        _claim(player, GameEconomy.ResourceType.GOLD, 10, 1);
        uint256 priceBefore = econ.goldPrice();

        vm.prank(player);
        econ.redeem(GameEconomy.ResourceType.GOLD, 5, 0);
        uint256 priceAfter = econ.goldPrice();

        assertGe(priceAfter, priceBefore);
    }

    // ── §4.2 claim voucher ───────────────────────────────────────────────────

    function test_claim_transfersFromTreasuryCustodyWithoutMinting() public {
        uint256 treasuryBalBefore = econ.balanceOf(address(econ), econ.GOLD_SHARE());

        _claim(player, GameEconomy.ResourceType.GOLD, 10, 1);

        assertEq(econ.balanceOf(player, econ.GOLD_SHARE()), 10);
        assertEq(econ.balanceOf(address(econ), econ.GOLD_SHARE()), treasuryBalBefore - 10);
    }

    function test_claim_doesNotAffectReserveOrSupplyOutstanding() public {
        uint256 duration = 1000;
        vm.prank(player);
        econ.enterGame{value: PRICE_PER_SECOND * duration}(duration);

        uint256 reserveBefore = econ.goldReserve();
        uint256 supplyBefore = econ.goldSupplyOutstanding();

        _claim(player, GameEconomy.ResourceType.GOLD, 10, 1);

        assertEq(econ.goldReserve(), reserveBefore);
        assertEq(econ.goldSupplyOutstanding(), supplyBefore);
    }

    function test_claim_revertsOnReplayedNonce() public {
        _claim(player, GameEconomy.ResourceType.GOLD, 10, 1);

        GameEconomy.Voucher memory v = _voucher(player, GameEconomy.ResourceType.GOLD, 10, 1);
        vm.expectRevert(bytes("nonce used"));
        econ.claim(v, _sign(v));
    }

    function test_claim_revertsOnExpiredVoucher() public {
        GameEconomy.Voucher memory v = _voucher(player, GameEconomy.ResourceType.GOLD, 10, 1);
        vm.warp(v.expiry + 1);
        vm.expectRevert(bytes("voucher expired"));
        econ.claim(v, _sign(v));
    }

    function test_claim_revertsOnBadSignature() public {
        GameEconomy.Voucher memory v = _voucher(player, GameEconomy.ResourceType.GOLD, 10, 1);
        uint256 wrongKey = 0xBEEF;
        bytes32 typeHash =
            keccak256("Voucher(address player,uint8 resourceType,uint256 amount,uint256 nonce,uint256 expiry)");
        bytes32 structHash =
            keccak256(abi.encode(typeHash, v.player, uint8(v.resourceType), v.amount, v.nonce, v.expiry));
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("MonadGameEconomy")),
                keccak256(bytes("1")),
                block.chainid,
                address(econ)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v_, bytes32 r, bytes32 s) = vm.sign(wrongKey, digest);

        vm.expectRevert(bytes("invalid signature"));
        econ.claim(v, abi.encodePacked(r, s, v_));
    }

    function test_claim_revertsWhenExceedingUnlockedDiamonds() public {
        GameEconomy.Voucher memory v = _voucher(player, GameEconomy.ResourceType.DIAMOND, 301, 1);
        vm.expectRevert(bytes("exceeds unlocked diamonds"));
        econ.claim(v, _sign(v));
    }

    function test_claim_succeedsUpToUnlockedDiamondCount() public {
        _claim(player, GameEconomy.ResourceType.DIAMOND, 300, 1);
        assertEq(econ.balanceOf(player, econ.DIAMOND_SHARE()), 300);
    }

    function test_claim_revertsPastOnChainRateCap() public {
        GameEconomy.Voucher memory v = _voucher(player, GameEconomy.ResourceType.GOLD, GOLD_CAP_PER_HOUR + 1, 1);
        vm.expectRevert(bytes("rate cap exceeded"));
        econ.claim(v, _sign(v));
    }

    function test_claim_rateCapResetsAfterWindow() public {
        _claim(player, GameEconomy.ResourceType.GOLD, GOLD_CAP_PER_HOUR, 1);

        GameEconomy.Voucher memory v = _voucher(player, GameEconomy.ResourceType.GOLD, 1, 2);
        vm.expectRevert(bytes("rate cap exceeded"));
        econ.claim(v, _sign(v));

        vm.warp(block.timestamp + 1 hours + 1);
        _claim(player, GameEconomy.ResourceType.GOLD, 1, 2);
        assertEq(econ.balanceOf(player, econ.GOLD_SHARE()), GOLD_CAP_PER_HOUR + 1);
    }

    function test_claim_revertsWhenPaused() public {
        vm.prank(owner);
        econ.pause();

        GameEconomy.Voucher memory v = _voucher(player, GameEconomy.ResourceType.GOLD, 1, 1);
        vm.expectRevert(bytes("EnforcedPause()"));
        econ.claim(v, _sign(v));
    }

    // ── §4.3 redeem ───────────────────────────────────────────────────────

    function test_redeem_burnsAndPaysOutFromReserve() public {
        uint256 duration = 1000;
        vm.prank(player);
        econ.enterGame{value: PRICE_PER_SECOND * duration}(duration);
        _claim(player, GameEconomy.ResourceType.GOLD, 100, 1);

        uint256 reserveBefore = econ.goldReserve();
        uint256 supplyBefore = econ.goldSupplyOutstanding();
        uint256 expectedPayout = (50 * reserveBefore) / supplyBefore;
        uint256 balBefore = player.balance;

        vm.prank(player);
        econ.redeem(GameEconomy.ResourceType.GOLD, 50, 0);

        assertEq(econ.balanceOf(player, econ.GOLD_SHARE()), 50);
        assertEq(player.balance, balBefore + expectedPayout);
        assertEq(econ.goldReserve(), reserveBefore - expectedPayout);
        assertEq(econ.goldRedeemed(), 50);
    }

    function test_redeem_revertsOnSlippage() public {
        uint256 duration = 1000;
        vm.prank(player);
        econ.enterGame{value: PRICE_PER_SECOND * duration}(duration);
        _claim(player, GameEconomy.ResourceType.GOLD, 100, 1);

        uint256 reserve = econ.goldReserve();
        uint256 supply = econ.goldSupplyOutstanding();
        uint256 actualPayout = (50 * reserve) / supply;

        vm.prank(player);
        vm.expectRevert(bytes("slippage"));
        econ.redeem(GameEconomy.ResourceType.GOLD, 50, actualPayout + 1);
    }

    function test_redeem_revertsWithoutBalance() public {
        // Resolve GOLD_SHARE() before vm.prank so that view call doesn't itself consume the prank.
        uint256 goldId = econ.GOLD_SHARE();
        vm.prank(player);
        vm.expectRevert(abi.encodeWithSelector(IERC1155Errors.ERC1155InsufficientBalance.selector, player, 0, 1, goldId));
        econ.redeem(GameEconomy.ResourceType.GOLD, 1, 0);
    }

    function test_redeem_revertsWhenPaused() public {
        vm.prank(owner);
        econ.pause();

        vm.prank(player);
        vm.expectRevert(bytes("EnforcedPause()"));
        econ.redeem(GameEconomy.ResourceType.GOLD, 1, 0);
    }

    /// @dev Explicit reentrancy attack per spec §7 step 4: a malicious receive() hook tries to
    /// call redeem() again mid-payout. nonReentrant must block the second call.
    function test_redeem_blocksReentrancy() public {
        uint256 duration = 2000;
        vm.deal(address(this), 100 ether);
        econ.enterGame{value: PRICE_PER_SECOND * duration}(duration);

        ReentrantRedeemer attacker = new ReentrantRedeemer(econ);
        vm.deal(address(attacker), 0);

        _claim(address(attacker), GameEconomy.ResourceType.GOLD, 100, 1);

        vm.expectRevert(bytes("MON transfer failed"));
        attacker.attack();
    }

    // ── Admin / circuit breaker ──────────────────────────────────────────────

    function test_onlyOwnerCanPause() public {
        vm.prank(player);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", player));
        econ.pause();
    }

    function test_onlyOwnerCanSetGameAuthority() public {
        vm.prank(player);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", player));
        econ.setGameAuthority(player);
    }
}

/// @dev Attempts to re-enter redeem() from `receive()`, triggered when the raw MON payout call
/// lands. Implements IERC1155Receiver only so the setup claim() (an ERC1155 safeTransferFrom) can
/// reach this contract at all — that acceptance check is unrelated to the reentrancy being tested.
contract ReentrantRedeemer {
    GameEconomy public econ;
    bool public attacked;

    constructor(GameEconomy _econ) {
        econ = _econ;
    }

    function attack() external {
        econ.redeem(GameEconomy.ResourceType.GOLD, 100, 0);
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    receive() external payable {
        if (!attacked) {
            attacked = true;
            econ.redeem(GameEconomy.ResourceType.GOLD, 1, 0);
        }
    }
}
