// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {HonkVerifier} from "../contracts/zk/WordleVerifier.sol";
import {WordleDuel} from "../contracts/zk/WordleDuel.sol";

// Deploys the trustless ZK Wordle duel: the generated UltraHonk verifier, then
// the WordleDuel match manager pointing at it. DICT_ROOT is the Poseidon Merkle
// root of the ANSWERS list — it MUST equal the root pinned in the circuit
// (circuits/wordle_feedback/src/main.nr) and reproduced by
// `bun run circuits/scripts/build-tree.ts`.
contract DeployWordleDuelScript is Script {
    // Poseidon Merkle root over the 2,315 ANSWERS (see circuits/README.md).
    bytes32 internal constant DICT_ROOT = 0x0984b03ac65fe9e4710ce7fb30f53d292b0d03f812b247ef32764d6018655f87;

    function run() external {
        address owner = vm.envAddress("DEPLOYER_ADDRESS");
        // ERC20Lift for the live Circles v2 Hub — must match the Hub the stake
        // token is wrapped through, or the constructor reverts InvalidToken.
        address erc20Lift = vm.envOr("ERC20_LIFT", address(0x5F99a795dD2743C36D63511f0D4bc667e6d3cDB5));
        // The Circles group inflation ERC20 (s-gCRC) all duels stake.
        address token = vm.envAddress("DUEL_TOKEN");

        vm.startBroadcast(owner);
        HonkVerifier verifier = new HonkVerifier();
        WordleDuel duel = new WordleDuel(erc20Lift, address(verifier), DICT_ROOT, token);
        vm.stopBroadcast();

        console.log("Verifier:  ", address(verifier));
        console.log("WordleDuel:", address(duel));
        console.log("Token:     ", token);
    }
}
