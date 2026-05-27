-- Lobby lookup: find the PvP games a player has joined, by address.
-- Backs GET /api/games?player=<address> so the frontend can discover the
-- on-chain gameId assigned after escrow.join().
CREATE INDEX idx_game_players_address ON game_players(address);
