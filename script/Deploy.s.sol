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
        address erc20Lift = vm.envOr("ERC20_LIFT", address(0xDA02CDB5279B3a1eF27Be3d91aE924495E6A5569));

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
