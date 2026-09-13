// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Pure math for the diamond unlock schedule (spec §4.5).
/// @dev Unlock N (N = 1, 2, 3, ...) becomes available `firstGapSeconds + (N-1) * gapIncrementSeconds`
/// after the previous unlock, i.e. gaps grow arithmetically. Cumulative unlock time is therefore
/// quadratic in the unlock index, and we invert it in closed form instead of looping on-chain.
library DiamondUnlock {
    /// @dev Cumulative seconds-since-genesis at which the n-th post-genesis diamond unlocks.
    /// T(n) = firstGap * n + gapIncrement * n * (n - 1) / 2, T(0) = 0.
    function cumulativeUnlockTime(uint256 n, uint256 firstGapSeconds, uint256 gapIncrementSeconds)
        internal
        pure
        returns (uint256)
    {
        if (n == 0) return 0;
        return firstGapSeconds * n + (gapIncrementSeconds * n * (n - 1)) / 2;
    }

    /// @notice How many diamonds beyond the genesis batch are unlocked after `elapsed` seconds.
    /// @param elapsed Seconds since genesis (block.timestamp - genesisTimestamp).
    /// @param firstGapSeconds Gap before the first post-genesis unlock.
    /// @param gapIncrementSeconds Arithmetic common difference added to each successive gap.
    /// @param maxAdditional Hard cap on additional unlocks (TOTAL_CAP - INITIAL_UNLOCKED).
    function additionalUnlockedCount(
        uint256 elapsed,
        uint256 firstGapSeconds,
        uint256 gapIncrementSeconds,
        uint256 maxAdditional
    ) internal pure returns (uint256) {
        if (maxAdditional == 0) return 0;

        uint256 n;
        if (gapIncrementSeconds == 0) {
            n = firstGapSeconds == 0 ? maxAdditional : elapsed / firstGapSeconds;
        } else {
            // Solve d/2 * n^2 + (a - d/2) * n - t <= 0 for the largest integer n, using the
            // quadratic formula scaled by 2 to stay in integer arithmetic:
            //   n = floor( (-(2a - d) + sqrt((2a - d)^2 + 8*d*t)) / (2d) )
            int256 a = int256(firstGapSeconds);
            int256 d = int256(gapIncrementSeconds);
            int256 b = 2 * a - d;
            uint256 bSquared = uint256(b * b);
            uint256 discriminant = bSquared + 8 * gapIncrementSeconds * elapsed;
            uint256 sqrtDiscriminant = Math.sqrt(discriminant);

            int256 numerator = int256(sqrtDiscriminant) - b;
            n = numerator <= 0 ? 0 : uint256(numerator) / (2 * gapIncrementSeconds);

            // Integer sqrt is a floor, so the closed form can be off by one at the boundary.
            // Correct with a bounded (<=2 iteration) local search against the exact formula.
            while (cumulativeUnlockTime(n + 1, firstGapSeconds, gapIncrementSeconds) <= elapsed) {
                n += 1;
            }
            while (n > 0 && cumulativeUnlockTime(n, firstGapSeconds, gapIncrementSeconds) > elapsed) {
                n -= 1;
            }
        }

        return n > maxAdditional ? maxAdditional : n;
    }
}
