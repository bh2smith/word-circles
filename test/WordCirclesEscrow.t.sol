// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/WordCirclesEscrow.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Mock CRC", "CRC") {
        _mint(msg.sender, 1_000_000e18);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract WordCirclesEscrowTest is Test {
    WordCirclesEscrow public escrow;
    MockToken public token;

    uint256 resolverKey = 0xA11CE;
    address resolver = vm.addr(resolverKey);
    address player1 = address(0x1);
    address player2 = address(0x2);
    uint256 amount = 10e18;
    uint128 capacity = 2;

    function setUp() public {
        escrow = new WordCirclesEscrow();
        token = new MockToken();
        token.mint(player1, 100e18);
        token.mint(player2, 100e18);

        vm.prank(player1);
        token.approve(address(escrow), type(uint256).max);
        vm.prank(player2);
        token.approve(address(escrow), type(uint256).max);
    }

    function _join(address player) internal returns (bytes32) {
        vm.prank(player);
        return escrow.join(resolver, address(token), amount, capacity);
    }

    function _signResolve(bytes32 gameId, address[] memory winners, uint256[] memory amounts_)
        internal
        view
        returns (bytes memory)
    {
        bytes32 hash = keccak256(abi.encode(gameId, winners, amounts_));
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(hash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(resolverKey, ethHash);
        return abi.encodePacked(r, s, v);
    }

    function test_joinCreatesGame() public {
        bytes32 gameId = _join(player1);

        (uint128 players, uint128 cap, address res, address creator, uint256 amt, address tok, bool settled) =
            escrow.games(gameId);

        assertEq(players, 1);
        assertEq(cap, capacity);
        assertEq(res, resolver);
        assertEq(creator, player1);
        assertEq(amt, amount);
        assertEq(tok, address(token));
        assertFalse(settled);
        assertTrue(escrow.isPlayerInGame(gameId, player1));
    }

    function test_secondPlayerJoins() public {
        bytes32 gameId = _join(player1);
        bytes32 gameId2 = _join(player2);

        assertEq(gameId, gameId2);

        (uint128 players,,,,,,) = escrow.games(gameId);
        assertEq(players, 2);
        assertTrue(escrow.isPlayerInGame(gameId, player2));
    }

    function test_tokensTransferredToEscrow() public {
        uint256 balBefore = token.balanceOf(player1);
        _join(player1);
        assertEq(token.balanceOf(player1), balBefore - amount);
        assertEq(token.balanceOf(address(escrow)), amount);
    }

    function test_revertDoubleJoin() public {
        _join(player1);
        vm.expectRevert(WordCirclesEscrow.PlayerAlreadyJoined.selector);
        _join(player1);
    }

    function test_revertInvalidCapacity() public {
        vm.prank(player1);
        vm.expectRevert(WordCirclesEscrow.InvalidCapacity.selector);
        escrow.join(resolver, address(token), amount, 1);
    }

    function test_revertZeroResolver() public {
        vm.prank(player1);
        vm.expectRevert(WordCirclesEscrow.InvalidResolver.selector);
        escrow.join(address(0), address(token), amount, capacity);
    }

    function test_resolveWinner() public {
        bytes32 gameId = _join(player1);
        _join(player2);

        address[] memory winners = new address[](1);
        winners[0] = player1;
        uint256[] memory payouts = new uint256[](1);
        payouts[0] = 20e18;

        bytes memory sig = _signResolve(gameId, winners, payouts);

        uint256 balBefore = token.balanceOf(player1);
        escrow.resolve(gameId, winners, payouts, sig);

        assertEq(token.balanceOf(player1), balBefore + 20e18);
        assertEq(token.balanceOf(address(escrow)), 0);

        (,,,,,, bool settled) = escrow.games(gameId);
        assertTrue(settled);
    }

    function test_resolveSplit() public {
        bytes32 gameId = _join(player1);
        _join(player2);

        address[] memory winners = new address[](2);
        winners[0] = player1;
        winners[1] = player2;
        uint256[] memory payouts = new uint256[](2);
        payouts[0] = 10e18;
        payouts[1] = 10e18;

        bytes memory sig = _signResolve(gameId, winners, payouts);
        escrow.resolve(gameId, winners, payouts, sig);

        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_revertResolveBeforeFull() public {
        bytes32 gameId = _join(player1);

        address[] memory winners = new address[](1);
        winners[0] = player1;
        uint256[] memory payouts = new uint256[](1);
        payouts[0] = 10e18;

        bytes memory sig = _signResolve(gameId, winners, payouts);

        vm.expectRevert(WordCirclesEscrow.NotStarted.selector);
        escrow.resolve(gameId, winners, payouts, sig);
    }

    function test_revertDoubleSettle() public {
        bytes32 gameId = _join(player1);
        _join(player2);

        address[] memory winners = new address[](1);
        winners[0] = player1;
        uint256[] memory payouts = new uint256[](1);
        payouts[0] = 20e18;

        bytes memory sig = _signResolve(gameId, winners, payouts);
        escrow.resolve(gameId, winners, payouts, sig);

        vm.expectRevert(WordCirclesEscrow.AlreadySettled.selector);
        escrow.resolve(gameId, winners, payouts, sig);
    }

    function test_revertBadSignature() public {
        bytes32 gameId = _join(player1);
        _join(player2);

        address[] memory winners = new address[](1);
        winners[0] = player1;
        uint256[] memory payouts = new uint256[](1);
        payouts[0] = 20e18;

        uint256 wrongKey = 0xBAD;
        bytes32 hash = keccak256(abi.encode(gameId, winners, payouts));
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(hash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongKey, ethHash);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.expectRevert(WordCirclesEscrow.InvalidSignature.selector);
        escrow.resolve(gameId, winners, payouts, sig);
    }

    function test_revertPayoutExceedsPot() public {
        bytes32 gameId = _join(player1);
        _join(player2);

        address[] memory winners = new address[](1);
        winners[0] = player1;
        uint256[] memory payouts = new uint256[](1);
        payouts[0] = 21e18;

        bytes memory sig = _signResolve(gameId, winners, payouts);

        vm.expectRevert(WordCirclesEscrow.InvalidPayouts.selector);
        escrow.resolve(gameId, winners, payouts, sig);
    }

    function test_revertWinnerNotInGame() public {
        bytes32 gameId = _join(player1);
        _join(player2);

        address[] memory winners = new address[](1);
        winners[0] = address(0xDEAD);
        uint256[] memory payouts = new uint256[](1);
        payouts[0] = 20e18;

        bytes memory sig = _signResolve(gameId, winners, payouts);

        vm.expectRevert(WordCirclesEscrow.InvalidWinner.selector);
        escrow.resolve(gameId, winners, payouts, sig);
    }

    function test_resolveWithRemainder() public {
        bytes32 gameId = _join(player1);
        _join(player2);

        address[] memory winners = new address[](1);
        winners[0] = player1;
        uint256[] memory payouts = new uint256[](1);
        payouts[0] = 15e18; // 15 of 20 pot — 5 remainder to resolver

        bytes memory sig = _signResolve(gameId, winners, payouts);

        uint256 resolverBefore = token.balanceOf(resolver);
        escrow.resolve(gameId, winners, payouts, sig);

        assertEq(token.balanceOf(player1), 100e18 - amount + 15e18);
        assertEq(token.balanceOf(resolver), resolverBefore + 5e18);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_resolveFullPayoutNoRemainder() public {
        bytes32 gameId = _join(player1);
        _join(player2);

        address[] memory winners = new address[](1);
        winners[0] = player1;
        uint256[] memory payouts = new uint256[](1);
        payouts[0] = 20e18;

        bytes memory sig = _signResolve(gameId, winners, payouts);

        uint256 resolverBefore = token.balanceOf(resolver);
        escrow.resolve(gameId, winners, payouts, sig);

        assertEq(token.balanceOf(resolver), resolverBefore);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_getPlayerCount() public {
        assertEq(escrow.getPlayerCount(resolver, address(token), amount, capacity), 0);
        _join(player1);
        assertEq(escrow.getPlayerCount(resolver, address(token), amount, capacity), 1);
        _join(player2);
        assertEq(escrow.getPlayerCount(resolver, address(token), amount, capacity), 2);
    }

    function test_newGameAfterFull() public {
        bytes32 gameId1 = _join(player1);
        _join(player2);

        address player3 = address(0x3);
        token.mint(player3, 100e18);
        vm.prank(player3);
        token.approve(address(escrow), type(uint256).max);

        vm.prank(player3);
        bytes32 gameId2 = escrow.join(resolver, address(token), amount, capacity);

        assertTrue(gameId1 != gameId2);
        (uint128 players,,,,,,) = escrow.games(gameId2);
        assertEq(players, 1);
    }

    function test_emitsCreatedAndJoined() public {
        bytes32 lobbyKey = keccak256(abi.encode(resolver, address(token), amount, capacity));
        bytes32 expectedGameId = keccak256(abi.encode(lobbyKey, uint256(0)));

        vm.expectEmit(true, true, true, true);
        emit WordCirclesEscrow.Created(expectedGameId, player1, resolver, address(token), amount, capacity);
        vm.expectEmit(true, true, true, true);
        emit WordCirclesEscrow.Joined(expectedGameId, player1, player1, 1);

        _join(player1);
    }

    function test_emitsResolved() public {
        bytes32 gameId = _join(player1);
        _join(player2);

        address[] memory winners = new address[](1);
        winners[0] = player1;
        uint256[] memory payouts = new uint256[](1);
        payouts[0] = 20e18;

        bytes memory sig = _signResolve(gameId, winners, payouts);

        vm.expectEmit(true, true, true, true);
        emit WordCirclesEscrow.Resolved(gameId, winners, payouts);
        escrow.resolve(gameId, winners, payouts, sig);
    }
}
