// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {GameEconomy} from "../src/GameEconomy.sol";

/// @notice Deploys GameEconomy to Monad testnet.
/// Usage:
///   forge script script/Deploy.s.sol:Deploy --rpc-url monad_testnet --broadcast --account deployer
/// Required env vars: GAME_AUTHORITY_ADDRESS. Optional: OWNER_ADDRESS (defaults to the broadcasting account).
contract Deploy is Script {
    // [CONFIGURE] operational defaults — all owner-tunable post-deploy via GameEconomy setters.
    uint256 constant DEFAULT_PRICE_PER_SECOND = 1e13; // ~0.036 MON/hour
    uint256 constant DEFAULT_DIAMOND_RESERVE_BPS = 7000; // 70% diamond / 30% gold
    uint256 constant DEFAULT_DIAMOND_CLAIM_CAP_PER_HOUR = 50;
    uint256 constant DEFAULT_GOLD_CLAIM_CAP_PER_HOUR = 500;

    function run() external returns (GameEconomy econ) {
        address gameAuthority = vm.envAddress("GAME_AUTHORITY_ADDRESS");
        string memory uri = vm.envOr("METADATA_URI", string("https://example.invalid/metadata/{id}.json"));

        vm.startBroadcast();

        // msg.sender here (before broadcasting starts) is forge-std's generic default-sender
        // constant, not the --account/--private-key actually being broadcast from — reading it
        // once broadcasting is active via readCallers() gives the real deployer address instead.
        (, address broadcaster,) = vm.readCallers();
        address owner = vm.envOr("OWNER_ADDRESS", broadcaster);

        econ = new GameEconomy(
            owner,
            gameAuthority,
            DEFAULT_PRICE_PER_SECOND,
            DEFAULT_DIAMOND_RESERVE_BPS,
            DEFAULT_DIAMOND_CLAIM_CAP_PER_HOUR,
            DEFAULT_GOLD_CLAIM_CAP_PER_HOUR,
            uri
        );
        vm.stopBroadcast();

        console.log("GameEconomy deployed at:", address(econ));
        console.log("Owner:", owner);
        console.log("Game authority:", gameAuthority);
    }
}
