// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {WordleDuel} from "../../contracts/zk/WordleDuel.sol";
import {HonkVerifier} from "../../contracts/zk/WordleVerifier.sol";
import {MockToken, MockERC20Lift} from "../WordCirclesEscrow.t.sol";

/// @notice End-to-end M3 test: a real bb-generated proof verified on-chain
///         through WordleDuel (the real HonkVerifier, not a mock). Also proves
///         the match-binding (M2) defends against cross-match proof replay.
///
///         Fixture `test/zk/fixtures/duel/solve_*` is a proof that the secret
///         "react" (B's word) scores 682 (solved) against the guess "react",
///         bound to the matchId produced by (alice, nonce=1). Regenerate it via
///         the steps in circuits/README.md if the circuit changes.
contract WordleDuelRealTest is Test {
    WordleDuel internal duel;
    HonkVerifier internal verifier;
    MockToken internal token;
    MockERC20Lift internal lift;

    // alice/nonce MUST reproduce the matchId the fixture proof is bound to.
    address internal constant alice = address(0xA11CE);
    address internal constant bob = address(0xB0B);
    address internal constant tokenAvatar = address(0xAA);
    uint256 internal constant NONCE = 1;

    bytes32 internal constant DICT_ROOT = 0x0984b03ac65fe9e4710ce7fb30f53d292b0d03f812b247ef32764d6018655f87;
    // commitmentB = poseidon2([react, salt=123456789, matchId(alice,1)]).
    bytes32 internal constant COMMIT_B = 0x00e01c0d6dcd5ce90b995ed425047e7afc52d67ef532bfe6c2c67bb9902397bb;
    bytes32 internal constant EXPECTED_MATCH_ID = 0x0203dd68657862fa26bd7c4a12a3a2b3bbf2220be739d51860c5d12e036c38ec;

    uint256 internal constant STAKE = 10e18;
    uint16 internal constant SOLVED = 682;

    function setUp() public {
        vm.warp(1_000_000);
        lift = new MockERC20Lift();
        token = new MockToken(tokenAvatar);
        lift.register(1, tokenAvatar, address(token));
        verifier = new HonkVerifier();
        duel = new WordleDuel(address(lift), address(verifier), DICT_ROOT, address(token));

        token.mint(alice, 100e18);
        token.mint(bob, 100e18);
        vm.prank(alice);
        token.approve(address(duel), type(uint256).max);
        vm.prank(bob);
        token.approve(address(duel), type(uint256).max);
    }

    function _react() internal pure returns (uint8[5] memory g) {
        // r e a c t -> 17,4,0,2,19
        g[0] = 17;
        g[1] = 4;
        g[2] = 0;
        g[3] = 2;
        g[4] = 19;
    }

    function _solveProof() internal view returns (bytes memory) {
        return vm.readFileBinary("test/zk/fixtures/duel/solve_proof");
    }

    function _setup(uint256 nonce) internal returns (bytes32 id) {
        vm.prank(alice);
        id = duel.createMatch(nonce, bytes32(uint256(0xA)), STAKE); // A's own commitment unused here
        vm.prank(bob);
        duel.joinMatch(id, COMMIT_B); // B's word is "react"
        vm.prank(alice);
        duel.submitGuess(id, _react()); // A guesses B's word
    }

    /// A real proof solves B's word on-chain; A wins the pot, claims via withdraw.
    function test_realProof_solveAndWin() public {
        bytes32 id = _setup(NONCE);
        assertEq(id, EXPECTED_MATCH_ID, "matchId must match the fixture binding");

        vm.prank(bob);
        duel.submitFeedback(id, SOLVED, _solveProof()); // verified by the real HonkVerifier

        (,,, uint8 solvedAt, bool solved,,,) = duel.getTrack(id, true);
        assertTrue(solved, "A solved B's word");
        assertEq(solvedAt, 1);

        vm.warp(block.timestamp + duel.MOVE_TIMEOUT() + 1); // B's track freezes
        duel.settle(id);
        assertEq(duel.withdrawable(alice), 2 * STAKE);

        uint256 bal = token.balanceOf(alice);
        vm.prank(alice);
        duel.withdraw();
        assertEq(token.balanceOf(alice), bal + 2 * STAKE);
    }

    /// The same proof replayed in a DIFFERENT match is rejected: the proof is
    /// bound to match-1's matchId, but the contract supplies match-2's, so the
    /// public inputs mismatch and verification fails (M2 defense). The generated
    /// verifier reverts (e.g. SumcheckFailed) on a mismatch rather than returning
    /// false, so the whole tx reverts — either way feedback is never recorded.
    function test_realProof_replayInOtherMatchRejected() public {
        bytes32 id2 = _setup(NONCE + 1); // different nonce → different matchId
        assertTrue(id2 != EXPECTED_MATCH_ID);
        vm.prank(bob);
        vm.expectRevert(); // verifier rejects mismatched public inputs
        duel.submitFeedback(id2, SOLVED, _solveProof());
    }

    /// Claiming a different feedback value with the real proof is rejected.
    function test_realProof_tamperedFeedbackRejected() public {
        bytes32 id = _setup(NONCE);
        vm.prank(bob);
        vm.expectRevert(); // proof attests 682, not 681
        duel.submitFeedback(id, 681, _solveProof());
    }

    /// A wrong committed word (so the proof's commitment != stored commitment) fails.
    function test_realProof_wrongCommitmentRejected() public {
        vm.prank(alice);
        bytes32 id = duel.createMatch(NONCE, bytes32(uint256(0xA)), STAKE);
        vm.prank(bob);
        duel.joinMatch(id, bytes32(uint256(0xBEEF))); // not the fixture's commitment
        vm.prank(alice);
        duel.submitGuess(id, _react());
        vm.prank(bob);
        vm.expectRevert();
        duel.submitFeedback(id, SOLVED, _solveProof());
    }
}
