CREATE TABLE IF NOT EXISTS games (
    id         TEXT PRIMARY KEY,
    game_type  TEXT NOT NULL DEFAULT 'daily',
    word_index INTEGER NOT NULL,
    salt       TEXT,
    commitment TEXT,
    status     TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS players (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    address    TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS guesses (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id      TEXT NOT NULL REFERENCES games(id),
    player_id    INTEGER NOT NULL REFERENCES players(id),
    guess_number INTEGER NOT NULL,
    word         TEXT NOT NULL,
    results      TEXT NOT NULL,
    is_correct   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(game_id, player_id, guess_number)
);

CREATE INDEX IF NOT EXISTS idx_guesses_game_player ON guesses(game_id, player_id);
CREATE INDEX IF NOT EXISTS idx_games_type_status ON games(game_type, status);
