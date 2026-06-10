// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {WordleDuel} from "../../contracts/zk/WordleDuel.sol";
import {IWordleVerifier} from "../../contracts/zk/IWordleVerifier.sol";
import {MockToken, MockERC20Lift} from "../WordCirclesEscrow.t.sol";

/// @notice Verifier stub — the M1 contract logic is exercised independently of
///         real proofs. Toggle `result` to simulate accept/reject.
contract MockVerifier is IWordleVerifier {
    bool public result = true;

    function setResult(bool r) external {
        result = r;
    }

    function verify(bytes calldata, bytes32[] calldata) external view returns (bool) {
        return result;
    }
}

contract WordleDuelTest is Test {
    WordleDuel internal duel;
    MockToken internal token;
    MockERC20Lift internal lift;
    MockVerifier internal verifier;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);
    address internal tokenAvatar = address(0xAA);
    bytes32 internal constant DICT_ROOT = bytes32(uint256(0x0984));
    bytes32 internal constant COMMIT_A = bytes32(uint256(0xA));
    bytes32 internal constant COMMIT_B = bytes32(uint256(0xB));
    uint256 internal constant STAKE = 10e18;

    uint16 internal constant SOLVED = 682; // all-correct packed feedback

    function setUp() public {
        vm.warp(1_000_000); // sane non-zero start for deadline math
        lift = new MockERC20Lift();
        token = new MockToken(tokenAvatar);
        lift.register(1, tokenAvatar, address(token)); // inflation type
        verifier = new MockVerifier();
        duel = new WordleDuel(address(lift), address(verifier), DICT_ROOT, address(token));

        token.mint(alice, 100e18);
        token.mint(bob, 100e18);
        vm.prank(alice);
        token.approve(address(duel), type(uint256).max);
        vm.prank(bob);
        token.approve(address(duel), type(uint256).max);
    }

    // --- helpers -----------------------------------------------------------

    function _create(address who, uint256 nonce) internal returns (bytes32 id) {
        vm.prank(who);
        id = duel.createMatch(nonce, COMMIT_A, STAKE);
    }

    function _active(uint256 nonce) internal returns (bytes32 id) {
        id = _create(alice, nonce);
        vm.prank(bob);
        duel.joinMatch(id, COMMIT_B);
    }

    function _g(uint8 a, uint8 b, uint8 c, uint8 d, uint8 e) internal pure returns (uint8[5] memory g) {
        g[0] = a;
        g[1] = b;
        g[2] = c;
        g[3] = d;
        g[4] = e;
    }

    function _guess(bytes32 id, address who) internal {
        vm.prank(who);
        duel.submitGuess(id, _g(2, 17, 0, 13, 4)); // "crane"
    }

    function _answer(bytes32 id, address owner, uint16 feedback) internal {
        vm.prank(owner);
        duel.submitFeedback(id, feedback, "");
    }

    // --- creation / join / cancel -----------------------------------------

    function test_createEscrowsStakeAndOpens() public {
        uint256 bal = token.balanceOf(alice);
        bytes32 id = _create(alice, 1);
        assertEq(token.balanceOf(alice), bal - STAKE);
        assertEq(token.balanceOf(address(duel)), STAKE);
        (address pa,,, bytes32 ca,,, WordleDuel.Status status) = duel.getMatch(id);
        assertEq(pa, alice);
        assertEq(ca, COMMIT_A);
        assertEq(uint8(status), uint8(WordleDuel.Status.Open));
    }

    function test_createRevertsZeroStake() public {
        vm.prank(alice);
        vm.expectRevert(WordleDuel.InvalidStake.selector);
        duel.createMatch(1, COMMIT_A, 0);
    }

    function test_createRevertsSameNonceReused() public {
        _create(alice, 1);
        vm.prank(alice);
        vm.expectRevert(WordleDuel.MatchExists.selector);
        duel.createMatch(1, COMMIT_A, STAKE);
    }

    function test_constructorRevertsNonInflationToken() public {
        MockToken bad = new MockToken(address(0xBB));
        lift.register(0, address(0xBB), address(bad)); // demurrage, not inflation
        vm.expectRevert(WordleDuel.InvalidToken.selector);
        new WordleDuel(address(lift), address(verifier), DICT_ROOT, address(bad));
    }

    function test_joinEscrowsStakeAndActivates() public {
        bytes32 id = _create(alice, 1);
        vm.prank(bob);
        duel.joinMatch(id, COMMIT_B);
        assertEq(token.balanceOf(address(duel)), 2 * STAKE);
        (, address pb,,, bytes32 cb,, WordleDuel.Status status) = duel.getMatch(id);
        assertEq(pb, bob);
        assertEq(cb, COMMIT_B);
        assertEq(uint8(status), uint8(WordleDuel.Status.Active));
    }

    function test_joinRevertsSelfPlay() public {
        bytes32 id = _create(alice, 1);
        vm.prank(alice);
        vm.expectRevert(WordleDuel.SelfPlay.selector);
        duel.joinMatch(id, COMMIT_B);
    }

    function test_joinRevertsAlreadyActive() public {
        bytes32 id = _active(1);
        address carol = address(0xCa201);
        token.mint(carol, 100e18);
        vm.prank(carol);
        token.approve(address(duel), type(uint256).max);
        vm.prank(carol);
        vm.expectRevert(WordleDuel.NotOpen.selector);
        duel.joinMatch(id, COMMIT_B);
    }

    function test_cancelRefundsAfterWindow() public {
        bytes32 id = _create(alice, 1);
        vm.warp(block.timestamp + duel.JOIN_WINDOW() + 1);
        uint256 bal = token.balanceOf(alice);
        vm.prank(alice);
        duel.cancelMatch(id);
        assertEq(token.balanceOf(alice), bal + STAKE);
        (,,,,,, WordleDuel.Status status) = duel.getMatch(id);
        assertEq(uint8(status), uint8(WordleDuel.Status.Cancelled));
    }

    function test_cancelRevertsBeforeWindow() public {
        bytes32 id = _create(alice, 1);
        vm.prank(alice);
        vm.expectRevert(WordleDuel.JoinWindowOpen.selector);
        duel.cancelMatch(id);
    }

    function test_cancelRevertsNotPlayer() public {
        bytes32 id = _create(alice, 1);
        vm.warp(block.timestamp + duel.JOIN_WINDOW() + 1);
        vm.prank(bob);
        vm.expectRevert(WordleDuel.NotPlayer.selector);
        duel.cancelMatch(id);
    }

    // --- gameplay ----------------------------------------------------------

    function test_submitGuessRecordsAndSetsPending() public {
        bytes32 id = _active(1);
        _guess(id, alice); // alice guesses on trackA
        (uint8 gc,,,,, bool pending,, uint8[5] memory g) = duel.getTrack(id, true);
        assertEq(gc, 1);
        assertTrue(pending);
        assertEq(g[0], 2);
    }

    function test_guessRevertsNotPlayer() public {
        bytes32 id = _active(1);
        vm.prank(address(0xDEAD));
        vm.expectRevert(WordleDuel.NotPlayer.selector);
        duel.submitGuess(id, _g(0, 0, 0, 0, 0));
    }

    function test_stackedGuessReverts() public {
        bytes32 id = _active(1);
        _guess(id, alice);
        vm.prank(alice);
        vm.expectRevert(WordleDuel.GuessPending.selector);
        duel.submitGuess(id, _g(0, 0, 0, 0, 0));
    }

    function test_guessRevertsOutOfRangeLetter() public {
        bytes32 id = _active(1);
        vm.prank(alice);
        vm.expectRevert(WordleDuel.InvalidLetter.selector);
        duel.submitGuess(id, _g(26, 0, 0, 0, 0)); // 26 is out of a..z
    }

    function test_guessRevertsAfterTurnExpired() public {
        bytes32 id = _active(1);
        vm.warp(block.timestamp + duel.MOVE_TIMEOUT() + 1);
        vm.prank(alice);
        vm.expectRevert(WordleDuel.TurnExpired.selector);
        duel.submitGuess(id, _g(0, 0, 0, 0, 0));
    }

    function test_feedbackRevertsNoPendingGuess() public {
        bytes32 id = _active(1);
        // bob tries to answer trackA but alice hasn't guessed
        vm.prank(bob);
        vm.expectRevert(WordleDuel.NoGuessPending.selector);
        duel.submitFeedback(id, 0, "");
    }

    function test_feedbackRevertsBadProof() public {
        bytes32 id = _active(1);
        _guess(id, alice);
        verifier.setResult(false);
        vm.prank(bob);
        vm.expectRevert(WordleDuel.InvalidProof.selector);
        duel.submitFeedback(id, 100, "");
    }

    function test_feedbackTalliesGreensAndOranges() public {
        bytes32 id = _active(1);
        _guess(id, alice);
        // feedback tiles [correct, present, absent, present, correct]
        // packed = 2 + 1*4 + 0 + 1*64 + 2*256 = 582 → greens=2, oranges=2
        _answer(id, bob, 582);
        (, uint8 greens, uint8 oranges,, bool solved,,,) = duel.getTrack(id, true);
        assertEq(greens, 2);
        assertEq(oranges, 2);
        assertFalse(solved);
    }

    // --- settlement: wins, forfeits, draws --------------------------------

    /// A solves her track; B never guesses → B's track freezes; A wins the pot.
    function test_happyPath_solverWinsPot() public {
        bytes32 id = _active(1);
        _guess(id, alice);
        _answer(id, bob, SOLVED); // A solves at guess 1
        (,,, uint8 solvedAt, bool solved,,,) = duel.getTrack(id, true);
        assertTrue(solved);
        assertEq(solvedAt, 1);

        vm.warp(block.timestamp + duel.MOVE_TIMEOUT() + 1); // B's track freezes
        duel.settle(id);

        // pull payments
        uint256 balA = token.balanceOf(alice);
        vm.prank(alice);
        duel.withdraw();
        assertEq(token.balanceOf(alice), balA + 2 * STAKE);
        vm.prank(bob);
        vm.expectRevert(WordleDuel.NothingToWithdraw.selector);
        duel.withdraw();
    }

    /// A guesses, B refuses to answer past the deadline → A wins by forfeit.
    function test_ownerForfeit_guesserWinsPot() public {
        bytes32 id = _active(1);
        _guess(id, alice); // sets B's answer deadline
        vm.warp(block.timestamp + duel.MOVE_TIMEOUT() + 1);
        duel.settle(id);
        assertEq(duel.withdrawable(alice), 2 * STAKE);
        assertEq(duel.withdrawable(bob), 0);
    }

    /// Both have an unanswered pending guess → both owners stalled → refund each.
    function test_bothOwnersForfeit_refundEach() public {
        bytes32 id = _active(1);
        _guess(id, alice);
        _guess(id, bob);
        vm.warp(block.timestamp + duel.MOVE_TIMEOUT() + 1);
        duel.settle(id);
        assertEq(duel.withdrawable(alice), STAKE);
        assertEq(duel.withdrawable(bob), STAKE);
    }

    /// Both solve; A used fewer guesses → A wins.
    function test_bothSolved_fewestGuessesWins() public {
        bytes32 id = _active(1);
        // A solves at guess 1
        _guess(id, alice);
        _answer(id, bob, SOLVED);
        // B solves at guess 2
        _guess(id, bob);
        _answer(id, alice, 0);
        _guess(id, bob);
        _answer(id, alice, SOLVED);

        duel.settle(id);
        assertEq(duel.withdrawable(alice), 2 * STAKE);
        assertEq(duel.withdrawable(bob), 0);
    }

    /// Both solve at the same guess count → tiebreak on greens.
    function test_bothSolvedSameGuess_tiebreakGreens() public {
        bytes32 id = _active(1);
        // A: guess1 yields 2 greens (582 → greens 2, oranges 2), guess2 solves.
        _guess(id, alice);
        _answer(id, bob, 582);
        _guess(id, alice);
        _answer(id, bob, SOLVED); // A solved at guess 2, greens 2+5=7
        // B: guess1 yields 0 greens (feedback 0), guess2 solves.
        _guess(id, bob);
        _answer(id, alice, 0);
        _guess(id, bob);
        _answer(id, alice, SOLVED); // B solved at guess 2, greens 0+5=5
        duel.settle(id);
        assertEq(duel.withdrawable(alice), 2 * STAKE); // more cumulative greens
        assertEq(duel.withdrawable(bob), 0);
    }

    /// Neither solves (both freeze with no progress) → refund each.
    function test_neitherSolves_refundEach() public {
        bytes32 id = _active(1);
        vm.warp(block.timestamp + duel.MOVE_TIMEOUT() + 1); // both guessers freeze
        duel.settle(id);
        assertEq(duel.withdrawable(alice), STAKE);
        assertEq(duel.withdrawable(bob), STAKE);
    }

    function test_settleRevertsGameOngoing() public {
        bytes32 id = _active(1);
        _guess(id, alice);
        _answer(id, bob, 0); // A still has guesses; nobody done
        vm.expectRevert(WordleDuel.GameOngoing.selector);
        duel.settle(id);
    }

    function test_doubleSettleReverts() public {
        bytes32 id = _active(1);
        vm.warp(block.timestamp + duel.MOVE_TIMEOUT() + 1);
        duel.settle(id);
        vm.expectRevert(WordleDuel.NotActive.selector);
        duel.settle(id);
    }

    function test_withdrawZeroesBalance() public {
        bytes32 id = _active(1);
        vm.warp(block.timestamp + duel.MOVE_TIMEOUT() + 1);
        duel.settle(id); // refund each
        vm.prank(alice);
        duel.withdraw();
        assertEq(duel.withdrawable(alice), 0);
        vm.prank(alice);
        vm.expectRevert(WordleDuel.NothingToWithdraw.selector);
        duel.withdraw();
    }

    /// Pot is conserved: contract holds exactly the unwithdrawn remainder.
    function test_potConservation() public {
        bytes32 id = _active(1);
        _guess(id, alice);
        vm.warp(block.timestamp + duel.MOVE_TIMEOUT() + 1);
        duel.settle(id); // A wins 2*STAKE by forfeit
        assertEq(token.balanceOf(address(duel)), 2 * STAKE);
        vm.prank(alice);
        duel.withdraw();
        assertEq(token.balanceOf(address(duel)), 0);
    }
}
