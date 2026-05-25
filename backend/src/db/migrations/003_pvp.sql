CREATE TABLE IF NOT EXISTS game_players (
    game_id     TEXT NOT NULL REFERENCES games(id),
    player_id   INTEGER NOT NULL REFERENCES players(id),
    address     TEXT NOT NULL,
    started_at  TEXT,
    finished_at TEXT,
    solved      INTEGER NOT NULL DEFAULT 0,
    guess_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (game_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_game_players_game ON game_players(game_id);

ALTER TABLE games ADD COLUMN capacity INTEGER;
ALTER TABLE games ADD COLUMN token TEXT;
ALTER TABLE games ADD COLUMN amount TEXT;
ALTER TABLE games ADD COLUMN timeout_secs INTEGER;
