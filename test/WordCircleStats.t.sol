// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/WordCircleStats.sol";

contract WordCircleStatsTest is Test {
    WordCircleStats public stats;

    address owner;
    address resolver;
    address player = address(0xBEEF);
    address player2 = address(0xCAFE);

    bytes32 pvpGameId = keccak256("pvp-game-1");
    uint256 wagerAmount = 10e18;

    function setUp() public {
        owner = makeAddr("owner");
        resolver = makeAddr("resolver");
        stats = new WordCircleStats(owner, resolver);
    }

    // --- daily: recordGame ---

    function test_recordWin() public {
        vm.prank(player);
        stats.recordGame(1, true, 3);

        (
            uint32 gamesPlayed,
            uint32 gamesWon,
            uint32 currentStreak,
            uint32 maxStreak,
            uint32 lastGameId,
            uint32[6] memory dist
        ) = stats.getStats(player);

        assertEq(gamesPlayed, 1);
        assertEq(gamesWon, 1);
        assertEq(currentStreak, 1);
        assertEq(maxStreak, 1);
        assertEq(lastGameId, 1);
        assertEq(dist[2], 1); // index 2 = solved in 3 guesses
    }

    function test_recordLoss() public {
        vm.prank(player);
        stats.recordGame(1, false, 6);

        (uint32 gamesPlayed, uint32 gamesWon, uint32 currentStreak,,,) = stats.getStats(player);

        assertEq(gamesPlayed, 1);
        assertEq(gamesWon, 0);
        assertEq(currentStreak, 0);
    }

    function test_streak() public {
        vm.startPrank(player);
        stats.recordGame(1, true, 4);
        stats.recordGame(2, true, 2);
        stats.recordGame(3, true, 5);
        vm.stopPrank();

        (,, uint32 currentStreak, uint32 maxStreak,,) = stats.getStats(player);
        assertEq(currentStreak, 3);
        assertEq(maxStreak, 3);
    }

    function test_streakBrokenByLoss() public {
        vm.startPrank(player);
        stats.recordGame(1, true, 4);
        stats.recordGame(2, true, 2);
        stats.recordGame(3, false, 6);
        stats.recordGame(4, true, 1);
        vm.stopPrank();

        (,, uint32 currentStreak, uint32 maxStreak,,) = stats.getStats(player);
        assertEq(currentStreak, 1);
        assertEq(maxStreak, 2);
    }

    function test_streakBrokenByGap() public {
        vm.startPrank(player);
        stats.recordGame(1, true, 3);
        stats.recordGame(2, true, 3);
        // skip game 3
        stats.recordGame(4, true, 3);
        vm.stopPrank();

        (,, uint32 currentStreak, uint32 maxStreak,,) = stats.getStats(player);
        assertEq(currentStreak, 1);
        assertEq(maxStreak, 2);
    }

    function test_revertDuplicateGame() public {
        vm.startPrank(player);
        stats.recordGame(5, true, 3);
        vm.expectRevert("Game already recorded");
        stats.recordGame(5, true, 4);
        vm.stopPrank();
    }

    function test_revertOlderGame() public {
        vm.startPrank(player);
        stats.recordGame(5, true, 3);
        vm.expectRevert("Game already recorded");
        stats.recordGame(3, true, 4);
        vm.stopPrank();
    }

    function test_revertInvalidGuessCount() public {
        vm.prank(player);
        vm.expectRevert("Invalid guess count");
        stats.recordGame(1, true, 0);
    }

    function test_guessDistribution() public {
        vm.startPrank(player);
        stats.recordGame(1, true, 1);
        stats.recordGame(2, true, 1);
        stats.recordGame(3, true, 3);
        stats.recordGame(4, true, 6);
        vm.stopPrank();

        (,,,,, uint32[6] memory dist) = stats.getStats(player);
        assertEq(dist[0], 2); // 2 games solved in 1 guess
        assertEq(dist[1], 0);
        assertEq(dist[2], 1); // 1 game solved in 3 guesses
        assertEq(dist[3], 0);
        assertEq(dist[4], 0);
        assertEq(dist[5], 1); // 1 game solved in 6 guesses
    }

    function test_emitsEvent() public {
        vm.prank(player);
        vm.expectEmit(true, true, false, true);
        emit WordCircleStats.GameRecorded(player, 1, true, 3);
        stats.recordGame(1, true, 3);
    }

    // --- pvp: recordPvpResult ---

    function test_pvpRecordWin() public {
        vm.prank(resolver);
        stats.recordPvpResult(pvpGameId, player, true, wagerAmount, wagerAmount * 2);

        (uint32 pvpWins, uint32 pvpLosses, uint256 totalWagered, uint256 totalEarned) = stats.getPvpStats(player);
        assertEq(pvpWins, 1);
        assertEq(pvpLosses, 0);
        assertEq(totalWagered, wagerAmount);
        assertEq(totalEarned, wagerAmount * 2);
    }

    function test_pvpRecordLoss() public {
        vm.prank(resolver);
        stats.recordPvpResult(pvpGameId, player, false, wagerAmount, 0);

        (uint32 pvpWins, uint32 pvpLosses, uint256 totalWagered, uint256 totalEarned) = stats.getPvpStats(player);
        assertEq(pvpWins, 0);
        assertEq(pvpLosses, 1);
        assertEq(totalWagered, wagerAmount);
        assertEq(totalEarned, 0);
    }

    function test_pvpRecordBothPlayers() public {
        vm.startPrank(resolver);
        stats.recordPvpResult(pvpGameId, player, true, wagerAmount, wagerAmount * 2);
        stats.recordPvpResult(pvpGameId, player2, false, wagerAmount, 0);
        vm.stopPrank();

        (uint32 w1,,,) = stats.getPvpStats(player);
        (, uint32 l2,,) = stats.getPvpStats(player2);
        assertEq(w1, 1);
        assertEq(l2, 1);
    }

    function test_pvpAccumulatesAcrossGames() public {
        bytes32 game2 = keccak256("pvp-game-2");

        vm.startPrank(resolver);
        stats.recordPvpResult(pvpGameId, player, true, wagerAmount, wagerAmount * 2);
        stats.recordPvpResult(game2, player, false, wagerAmount, 0);
        vm.stopPrank();

        (uint32 pvpWins, uint32 pvpLosses, uint256 totalWagered, uint256 totalEarned) = stats.getPvpStats(player);
        assertEq(pvpWins, 1);
        assertEq(pvpLosses, 1);
        assertEq(totalWagered, wagerAmount * 2);
        assertEq(totalEarned, wagerAmount * 2);
    }

    function test_pvpEmitsEvent() public {
        vm.prank(resolver);
        vm.expectEmit(true, true, false, true);
        emit WordCircleStats.PvpResultRecorded(pvpGameId, player, true, wagerAmount, wagerAmount * 2);
        stats.recordPvpResult(pvpGameId, player, true, wagerAmount, wagerAmount * 2);
    }

    function test_pvpRevertsIfNotResolver() public {
        vm.prank(player);
        vm.expectRevert(WordCircleStats.Unauthorized.selector);
        stats.recordPvpResult(pvpGameId, player, true, wagerAmount, wagerAmount * 2);
    }

    function test_pvpRevertsIfAlreadyRecorded() public {
        vm.prank(resolver);
        stats.recordPvpResult(pvpGameId, player, true, wagerAmount, wagerAmount * 2);

        vm.prank(resolver);
        vm.expectRevert(WordCircleStats.AlreadyRecorded.selector);
        stats.recordPvpResult(pvpGameId, player, true, wagerAmount, wagerAmount * 2);
    }

    function test_pvpDoesNotAffectDailyStats() public {
        vm.prank(resolver);
        stats.recordPvpResult(pvpGameId, player, true, wagerAmount, wagerAmount * 2);

        (uint32 gamesPlayed, uint32 gamesWon,,,,) = stats.getStats(player);
        assertEq(gamesPlayed, 0);
        assertEq(gamesWon, 0);
    }

    function test_dailyDoesNotAffectPvpStats() public {
        vm.prank(player);
        stats.recordGame(1, true, 3);

        (uint32 pvpWins, uint32 pvpLosses, uint256 totalWagered, uint256 totalEarned) = stats.getPvpStats(player);
        assertEq(pvpWins, 0);
        assertEq(pvpLosses, 0);
        assertEq(totalWagered, 0);
        assertEq(totalEarned, 0);
    }

    // --- ownership ---

    function test_setResolver() public {
        address newResolver = makeAddr("newResolver");
        vm.prank(owner);
        stats.setResolver(newResolver);
        assertEq(stats.resolver(), newResolver);
    }

    function test_setResolverRevertsIfNotOwner() public {
        vm.prank(player);
        vm.expectRevert(WordCircleStats.Unauthorized.selector);
        stats.setResolver(makeAddr("newResolver"));
    }

    function test_transferOwnership() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        stats.transferOwnership(newOwner);
        assertEq(stats.owner(), newOwner);
    }

    function test_lockResolver() public {
        vm.prank(owner);
        stats.transferOwnership(address(0));
        assertEq(stats.owner(), address(0));

        vm.prank(player);
        vm.expectRevert(WordCircleStats.Unauthorized.selector);
        stats.setResolver(makeAddr("newResolver"));
    }

    function test_transferOwnershipRevertsIfNotOwner() public {
        vm.prank(player);
        vm.expectRevert(WordCircleStats.Unauthorized.selector);
        stats.transferOwnership(makeAddr("newOwner"));
    }
}
