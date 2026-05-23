// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../contracts/WordCircleStats.sol";
import "../contracts/WordCommitment.sol";

// Word list (2,315 answers, one per line) pinned on IPFS:
//   CID:  QmWaw2pGNQJqQmyWTeoaAJcMygUdSj69Dxq8v422HjmPBa
//   URI:  ipfs://QmWaw2pGNQJqQmyWTeoaAJcMygUdSj69Dxq8v422HjmPBa
//   Hash: 0xed01643704d9284f12c5b5fb16717cffa1a2cf4ed0cc01ac6274bc63df2b266a
//   Verify: fetch file, strip newlines, keccak256 the concatenated bytes.

contract DeployScript is Script {
    function run() external {
        address resolver = vm.envAddress("RESOLVER_ADDRESS");
        bytes32 wordListHash = vm.envBytes32("WORD_LIST_HASH");
        string memory wordListUri = vm.envString("WORD_LIST_URI");

        vm.startBroadcast();
        new WordCircleStats(msg.sender, resolver);
        new WordCommitment(msg.sender, resolver, wordListHash, wordListUri);
        vm.stopBroadcast();
    }
}
