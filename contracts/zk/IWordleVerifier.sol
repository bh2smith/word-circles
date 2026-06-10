// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal interface for the generated UltraHonk verifier
///         (`contracts/zk/WordleVerifier.sol`'s `HonkVerifier`). WordleDuel
///         depends on this interface, not the generated file, so the verifier
///         can be regenerated (and swapped for a mock in tests) freely.
interface IWordleVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external view returns (bool);
}
