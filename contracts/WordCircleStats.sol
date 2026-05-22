// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title WordCircleStats — on-chain game statistics for Word Circles
/// @notice Daily stats are self-reported by players. PvP results are
///         recorded by the resolver to prevent fabrication.
contract WordCircleStats {
    struct PlayerStats {
        // Daily
        uint32 gamesPlayed;
        uint32 gamesWon;
        uint32 currentStreak;
        uint32 maxStreak;
        uint32 lastGameId;
        uint32[6] guessDistribution; // index 0 = solved in 1 guess, etc.
        // PvP
        uint32 pvpWins;
        uint32 pvpLosses;
        uint256 totalWagered;
        uint256 totalEarned;
    }

    address public owner;
    address public resolver;
    mapping(address => PlayerStats) public stats;
    mapping(bytes32 => mapping(address => bool)) public pvpRecorded;

    event GameRecorded(address indexed player, uint32 indexed gameId, bool won, uint8 guesses);
    event PvpResultRecorded(
        bytes32 indexed gameId, address indexed player, bool won, uint256 amountWagered, uint256 amountEarned
    );

    error AlreadyRecorded();
    error Unauthorized();

    constructor(address _owner, address _resolver) {
        owner = _owner;
        resolver = _resolver;
    }

    function setResolver(address _resolver) external {
        if (msg.sender != owner) revert Unauthorized();
        resolver = _resolver;
    }

    function transferOwnership(address _owner) external {
        if (msg.sender != owner) revert Unauthorized();
        owner = _owner;
    }

    /// @notice Record a completed daily game (self-reported by player)
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

    /// @notice Record a PvP game result on behalf of a player (resolver only)
    /// @param gameId         The escrow contract's bytes32 game identifier
    /// @param player         The player whose result is being recorded
    /// @param won            Whether this player won
    /// @param amountWagered  Token amount the player staked
    /// @param amountEarned   Token amount the player received from settlement
    function recordPvpResult(bytes32 gameId, address player, bool won, uint256 amountWagered, uint256 amountEarned)
        external
    {
        if (msg.sender != resolver) revert Unauthorized();
        if (pvpRecorded[gameId][player]) revert AlreadyRecorded();

        pvpRecorded[gameId][player] = true;

        PlayerStats storage s = stats[player];
        if (won) {
            s.pvpWins++;
        } else {
            s.pvpLosses++;
        }
        s.totalWagered += amountWagered;
        s.totalEarned += amountEarned;

        emit PvpResultRecorded(gameId, player, won, amountWagered, amountEarned);
    }

    /// @notice Get daily stats for a player
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

    /// @notice Get PvP stats for a player
    function getPvpStats(address player)
        external
        view
        returns (uint32 pvpWins, uint32 pvpLosses, uint256 totalWagered, uint256 totalEarned)
    {
        PlayerStats storage s = stats[player];
        return (s.pvpWins, s.pvpLosses, s.totalWagered, s.totalEarned);
    }
}
