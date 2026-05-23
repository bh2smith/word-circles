// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/WordCommitment.sol";

contract WordCommitmentTest is Test {
    WordCommitment public commitment;

    address owner;
    address resolver;
    address stranger = address(0x999);

    bytes32 constant WORD_LIST_HASH = keccak256("placeholder-word-list-hash");
    string constant WORD_LIST_URI = "ipfs://QmWaw2pGNQJqQmyWTeoaAJcMygUdSj69Dxq8v422HjmPBa";

    bytes32 gameId = keccak256("game-1");
    uint256 wordIndex = 42;
    bytes32 salt = bytes32(uint256(0xdeadbeef));
    bytes32 commitHash;

    function setUp() public {
        owner = makeAddr("owner");
        resolver = makeAddr("resolver");
        commitment = new WordCommitment(owner, resolver, WORD_LIST_HASH, WORD_LIST_URI);
        commitHash = keccak256(abi.encode(gameId, wordIndex, salt));
    }

    // --- constructor ---

    function test_constructorSetsWordListHash() public view {
        assertEq(commitment.wordListHash(), WORD_LIST_HASH);
    }

    function test_constructorSetsWordListUri() public view {
        assertEq(commitment.wordListUri(), WORD_LIST_URI);
    }

    // --- commit ---

    function test_commitStoresHash() public {
        vm.prank(resolver);
        commitment.commit(gameId, commitHash);

        (bytes32 stored,,,) = commitment.commitments(gameId);
        assertEq(stored, commitHash);
    }

    function test_commitEmitsEvent() public {
        vm.prank(resolver);
        vm.expectEmit(true, false, false, true);
        emit WordCommitment.Committed(gameId, commitHash);
        commitment.commit(gameId, commitHash);
    }

    function test_commitRevertsIfNotResolver() public {
        vm.prank(stranger);
        vm.expectRevert(WordCommitment.Unauthorized.selector);
        commitment.commit(gameId, commitHash);
    }

    function test_commitRevertsIfAlreadyCommitted() public {
        vm.prank(resolver);
        commitment.commit(gameId, commitHash);

        vm.prank(resolver);
        vm.expectRevert(WordCommitment.AlreadyCommitted.selector);
        commitment.commit(gameId, commitHash);
    }

    // --- reveal ---

    function test_revealSucceeds() public {
        vm.prank(resolver);
        commitment.commit(gameId, commitHash);

        vm.prank(resolver);
        commitment.reveal(gameId, wordIndex, salt);

        (, uint256 storedIndex, bytes32 storedSalt, bool revealed) = commitment.commitments(gameId);
        assertEq(storedIndex, wordIndex);
        assertEq(storedSalt, salt);
        assertTrue(revealed);
    }

    function test_revealEmitsEvent() public {
        vm.prank(resolver);
        commitment.commit(gameId, commitHash);

        vm.prank(resolver);
        vm.expectEmit(true, false, false, true);
        emit WordCommitment.Revealed(gameId, wordIndex, salt);
        commitment.reveal(gameId, wordIndex, salt);
    }

    function test_revealRevertsIfNotResolver() public {
        vm.prank(resolver);
        commitment.commit(gameId, commitHash);

        vm.prank(stranger);
        vm.expectRevert(WordCommitment.Unauthorized.selector);
        commitment.reveal(gameId, wordIndex, salt);
    }

    function test_revealRevertsIfNotCommitted() public {
        vm.prank(resolver);
        vm.expectRevert(WordCommitment.NotCommitted.selector);
        commitment.reveal(gameId, wordIndex, salt);
    }

    function test_revealRevertsIfAlreadyRevealed() public {
        vm.prank(resolver);
        commitment.commit(gameId, commitHash);
        vm.prank(resolver);
        commitment.reveal(gameId, wordIndex, salt);

        vm.prank(resolver);
        vm.expectRevert(WordCommitment.AlreadyRevealed.selector);
        commitment.reveal(gameId, wordIndex, salt);
    }

    function test_revealRevertsOnWrongWordIndex() public {
        vm.prank(resolver);
        commitment.commit(gameId, commitHash);

        vm.prank(resolver);
        vm.expectRevert(WordCommitment.InvalidReveal.selector);
        commitment.reveal(gameId, wordIndex + 1, salt);
    }

    function test_revealRevertsOnWrongSalt() public {
        vm.prank(resolver);
        commitment.commit(gameId, commitHash);

        vm.prank(resolver);
        vm.expectRevert(WordCommitment.InvalidReveal.selector);
        commitment.reveal(gameId, wordIndex, bytes32(uint256(0xbadbeef)));
    }

    // --- verify ---

    function test_verifyReturnsTrueAfterReveal() public {
        vm.prank(resolver);
        commitment.commit(gameId, commitHash);
        vm.prank(resolver);
        commitment.reveal(gameId, wordIndex, salt);

        assertTrue(commitment.verify(gameId));
    }

    function test_verifyReturnsFalseBeforeReveal() public {
        vm.prank(resolver);
        commitment.commit(gameId, commitHash);

        assertFalse(commitment.verify(gameId));
    }

    function test_verifyReturnsFalseForUnknownGame() public {
        assertFalse(commitment.verify(keccak256("unknown")));
    }

    // --- ownership ---

    function test_setResolver() public {
        address newResolver = makeAddr("newResolver");
        vm.prank(owner);
        commitment.setResolver(newResolver);
        assertEq(commitment.resolver(), newResolver);
    }

    function test_setResolverRevertsIfNotOwner() public {
        vm.prank(stranger);
        vm.expectRevert(WordCommitment.Unauthorized.selector);
        commitment.setResolver(makeAddr("newResolver"));
    }

    function test_transferOwnership() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        commitment.transferOwnership(newOwner);
        assertEq(commitment.owner(), newOwner);
    }

    function test_lockResolver() public {
        vm.prank(owner);
        commitment.transferOwnership(address(0));
        assertEq(commitment.owner(), address(0));

        vm.prank(stranger);
        vm.expectRevert(WordCommitment.Unauthorized.selector);
        commitment.setResolver(makeAddr("newResolver"));
    }

    function test_transferOwnershipRevertsIfNotOwner() public {
        vm.prank(stranger);
        vm.expectRevert(WordCommitment.Unauthorized.selector);
        commitment.transferOwnership(makeAddr("newOwner"));
    }

    // --- fuzz ---

    function testFuzz_commitRevealVerify(bytes32 fuzzGameId, uint256 fuzzWordIndex, bytes32 fuzzSalt) public {
        bytes32 h = keccak256(abi.encode(fuzzGameId, fuzzWordIndex, fuzzSalt));

        vm.prank(resolver);
        commitment.commit(fuzzGameId, h);

        vm.prank(resolver);
        commitment.reveal(fuzzGameId, fuzzWordIndex, fuzzSalt);

        assertTrue(commitment.verify(fuzzGameId));
    }
}
