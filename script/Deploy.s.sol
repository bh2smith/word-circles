// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../contracts/WordCircleStats.sol";
import "../contracts/WordCirclesEscrow.sol";
import "../contracts/WordCommitment.sol";

// Word list (2,315 answers, one per line) pinned on IPFS:
//   CID:  QmWaw2pGNQJqQmyWTeoaAJcMygUdSj69Dxq8v422HjmPBa
//   URI:  ipfs://QmWaw2pGNQJqQmyWTeoaAJcMygUdSj69Dxq8v422HjmPBa
//   Hash: 0xed01643704d9284f12c5b5fb16717cffa1a2cf4ed0cc01ac6274bc63df2b266a
//   Verify: fetch file, strip newlines, keccak256 the concatenated bytes.

contract DeployScript is Script {
    bytes32 constant WORD_LIST_HASH = 0xed01643704d9284f12c5b5fb16717cffa1a2cf4ed0cc01ac6274bc63df2b266a;
    string constant WORD_LIST_URI = "ipfs://QmWaw2pGNQJqQmyWTeoaAJcMygUdSj69Dxq8v422HjmPBa";

    function run() external {
        address owner = vm.envAddress("DEPLOYER_ADDRESS");
        address resolver = vm.envAddress("RESOLVER_ADDRESS");
        // ERC20Lift for the live Circles v2 Hub (0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8) on
        // Gnosis mainnet — must match the Hub that stake tokens are wrapped through, or join()
        // reverts InvalidToken. The previous default (0xDA02CDB5...) was bound to an old/other Hub
        // (0x2200542D...) and rejected every current Circles token.
        address erc20Lift = vm.envOr("ERC20_LIFT", address(0x5F99a795dD2743C36D63511f0D4bc667e6d3cDB5));

        vm.startBroadcast(owner);

        WordCirclesEscrow escrow = new WordCirclesEscrow(erc20Lift);
        WordCircleStats stats = new WordCircleStats(owner, resolver);
        WordCommitment commitment = new WordCommitment(owner, resolver, WORD_LIST_HASH, WORD_LIST_URI);

        vm.stopBroadcast();

        console.log("Escrow:     ", address(escrow));
        console.log("Stats:      ", address(stats));
        console.log("Commitment: ", address(commitment));
        console.log("Resolver:   ", resolver);
        console.log("Owner:      ", owner);
    }
}
