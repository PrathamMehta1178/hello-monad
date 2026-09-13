// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DiamondUnlock} from "../src/DiamondUnlock.sol";

contract DiamondUnlockTest is Test {
    uint256 constant FIRST_GAP = 1 days;
    uint256 constant INCREMENT = (1 days) / 5; // 0.2 days
    uint256 constant MAX_ADDITIONAL = 700; // TOTAL_DIAMOND_CAP(1000) - INITIAL(300)

    /// @dev Reference implementation: sums gaps one at a time. Used to cross-check the closed-form
    /// inversion in DiamondUnlock.additionalUnlockedCount.
    function _referenceCount(uint256 elapsed, uint256 firstGap, uint256 increment, uint256 maxAdditional)
        internal
        pure
        returns (uint256)
    {
        uint256 n = 0;
        uint256 cumulative = 0;
        uint256 gap = firstGap;
        while (n < maxAdditional) {
            cumulative += gap;
            if (cumulative > elapsed) break;
            n += 1;
            gap += increment;
        }
        return n;
    }

    function test_zeroElapsed_zeroAdditional() public pure {
        assertEq(DiamondUnlock.additionalUnlockedCount(0, FIRST_GAP, INCREMENT, MAX_ADDITIONAL), 0);
    }

    function test_justBeforeFirstGap_stillZero() public pure {
        assertEq(DiamondUnlock.additionalUnlockedCount(FIRST_GAP - 1, FIRST_GAP, INCREMENT, MAX_ADDITIONAL), 0);
    }

    function test_exactlyFirstGap_unlocksOne() public pure {
        assertEq(DiamondUnlock.additionalUnlockedCount(FIRST_GAP, FIRST_GAP, INCREMENT, MAX_ADDITIONAL), 1);
    }

    function test_exactlySecondGap_unlocksTwo() public pure {
        uint256 t = FIRST_GAP + (FIRST_GAP + INCREMENT);
        assertEq(DiamondUnlock.additionalUnlockedCount(t, FIRST_GAP, INCREMENT, MAX_ADDITIONAL), 2);
    }

    function test_oneSecondBeforeSecondGap_stillOne() public pure {
        uint256 t = FIRST_GAP + (FIRST_GAP + INCREMENT) - 1;
        assertEq(DiamondUnlock.additionalUnlockedCount(t, FIRST_GAP, INCREMENT, MAX_ADDITIONAL), 1);
    }

    function test_capsAtMaxAdditional_evenAfterCenturies() public pure {
        uint256 farFuture = 365 days * 200;
        assertEq(
            DiamondUnlock.additionalUnlockedCount(farFuture, FIRST_GAP, INCREMENT, MAX_ADDITIONAL), MAX_ADDITIONAL
        );
    }

    function test_zeroIncrement_isLinear() public pure {
        uint256 t = FIRST_GAP * 5 + (FIRST_GAP / 2);
        assertEq(DiamondUnlock.additionalUnlockedCount(t, FIRST_GAP, 0, MAX_ADDITIONAL), 5);
    }

    function test_zeroMaxAdditional_alwaysZero() public pure {
        assertEq(DiamondUnlock.additionalUnlockedCount(365 days, FIRST_GAP, INCREMENT, 0), 0);
    }

    /// @dev Fuzz across a wide range of elapsed times and cross-check against the loop-based
    /// reference implementation, as the build order (§7 step 2) calls for.
    function testFuzz_matchesReferenceImplementation(uint256 elapsedDays) public pure {
        uint256 elapsed = bound(elapsedDays, 0, 400) * 1 days + (elapsedDays % 86400);
        uint256 expected = _referenceCount(elapsed, FIRST_GAP, INCREMENT, MAX_ADDITIONAL);
        uint256 actual = DiamondUnlock.additionalUnlockedCount(elapsed, FIRST_GAP, INCREMENT, MAX_ADDITIONAL);
        assertEq(actual, expected);
    }

    /// @dev Bounded to realistic `block.timestamp - genesisTimestamp` values (up to ~10,000 years).
    /// Far outside that domain the discriminant term (8 * gapIncrement * elapsed) can overflow
    /// uint256, but block.timestamp cannot realistically reach values that trigger it.
    function testFuzz_neverExceedsCap(uint256 elapsed) public pure {
        elapsed = bound(elapsed, 0, 3650000 days);
        uint256 actual = DiamondUnlock.additionalUnlockedCount(elapsed, FIRST_GAP, INCREMENT, MAX_ADDITIONAL);
        assertLe(actual, MAX_ADDITIONAL);
    }

    function testFuzz_monotonicallyNonDecreasing(uint256 t1, uint256 t2) public pure {
        t1 = bound(t1, 0, 365 days * 10);
        t2 = bound(t2, 0, 365 days * 10);
        if (t1 > t2) (t1, t2) = (t2, t1);
        uint256 c1 = DiamondUnlock.additionalUnlockedCount(t1, FIRST_GAP, INCREMENT, MAX_ADDITIONAL);
        uint256 c2 = DiamondUnlock.additionalUnlockedCount(t2, FIRST_GAP, INCREMENT, MAX_ADDITIONAL);
        assertGe(c2, c1);
    }
}
