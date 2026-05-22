// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../contracts/WordCircleStats.sol";
import "../contracts/WordCommitment.sol";

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
