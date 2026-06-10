// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {DeployWordleDuelScript} from "../../script/DeployWordleDuel.s.sol";

/// @notice Guards the pinned dictionary root against accidental drift. The same
///         value must appear in: this test, the deploy script, WordleDuel (via
///         the deploy arg), the circuit (circuits/wordle_feedback/src/main.nr),
///         and be reproduced by `bun run circuits/scripts/build-tree.ts react`
///         and src/lib/duel/tree.test.ts. If you intentionally change the circuit
///         or answer list, update all of them together.
contract DictRootTest is Test, DeployWordleDuelScript {
    bytes32 internal constant PINNED = 0x0984b03ac65fe9e4710ce7fb30f53d292b0d03f812b247ef32764d6018655f87;

    function test_deployScriptDictRootIsPinned() public pure {
        assertEq(DICT_ROOT, PINNED, "deploy DICT_ROOT drifted from the ANSWERS Merkle root");
    }
}
