// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/WordCircleStats.sol";

contract WordCircleStatsTest is Test {
    WordCircleStats public stats;
    address player = address(0xBEEF);

    function setUp() public {
        stats = new WordCircleStats();
    }

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
}
