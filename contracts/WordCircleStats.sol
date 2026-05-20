// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title WordCircleStats — on-chain game statistics for Word Circle
contract WordCircleStats {
    struct PlayerStats {
        uint32 gamesPlayed;
        uint32 gamesWon;
        uint32 currentStreak;
        uint32 maxStreak;
        uint32 lastGameId;
        uint32[6] guessDistribution; // index 0 = solved in 1 guess, etc.
    }

    mapping(address => PlayerStats) public stats;

    event GameRecorded(address indexed player, uint32 indexed gameId, bool won, uint8 guesses);

    /// @notice Record a completed game result
    /// @param gameId The daily game number
    /// @param won Whether the player won
    /// @param guesses Number of guesses used (1-6)
    function recordGame(uint32 gameId, bool won, uint8 guesses) external {
        require(guesses >= 1 && guesses <= 6, "Invalid guess count");

        PlayerStats storage s = stats[msg.sender];
        require(gameId > s.lastGameId, "Game already recorded");

        uint32 prevGameId = s.lastGameId;
        s.gamesPlayed++;
        s.lastGameId = gameId;

        if (won) {
            s.gamesWon++;
            s.guessDistribution[guesses - 1]++;

            bool consecutive = prevGameId == 0 || gameId == prevGameId + 1;
            if (consecutive) {
                s.currentStreak++;
            } else {
                s.currentStreak = 1;
            }

            if (s.currentStreak > s.maxStreak) {
                s.maxStreak = s.currentStreak;
            }
        } else {
            s.currentStreak = 0;
        }

        emit GameRecorded(msg.sender, gameId, won, guesses);
    }

    /// @notice Get full stats for a player
    function getStats(address player)
        external
        view
        returns (
            uint32 gamesPlayed,
            uint32 gamesWon,
            uint32 currentStreak,
            uint32 maxStreak,
            uint32 lastGameId,
            uint32[6] memory guessDistribution
        )
    {
        PlayerStats storage s = stats[player];
        return (s.gamesPlayed, s.gamesWon, s.currentStreak, s.maxStreak, s.lastGameId, s.guessDistribution);
    }
}
