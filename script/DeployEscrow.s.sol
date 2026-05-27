// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../contracts/WordCirclesEscrow.sol";

// Redeploys ONLY the escrow — e.g. to point it at a corrected ERC20Lift.
// WordCircleStats and WordCommitment are independent (the escrow takes only
// `_erc20Lift`, and neither of the others references the escrow), so they are
// intentionally NOT deployed here.
//
// After deploying, update the new escrow address in:
//   - deployment/docker-compose.yml      (ESCROW_ADDRESS)
//   - deployment/arak.toml + deployment/indexer/arak.toml
//       (the created/joined/resolved `contract`, and bump `start` to this deploy block)
//   - README.md contract table
// then republish + reinstall the DAppNode package.
contract DeployEscrowScript is Script {
    function run() external {
        address owner = vm.envAddress("DEPLOYER_ADDRESS");
        // ERC20Lift for the live Circles v2 Hub (0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8).
        // Must match the Hub the stake tokens are wrapped through, or join() reverts
        // InvalidToken.
        address erc20Lift = vm.envOr("ERC20_LIFT", address(0x5F99a795dD2743C36D63511f0D4bc667e6d3cDB5));

        vm.startBroadcast(owner);
        WordCirclesEscrow escrow = new WordCirclesEscrow(erc20Lift);
        vm.stopBroadcast();

        console.log("Escrow:    ", address(escrow));
        console.log("ERC20Lift: ", erc20Lift);
    }
}
