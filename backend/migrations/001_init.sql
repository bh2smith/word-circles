-- Word Circles: full schema
-- All addresses stored as BYTEA (raw 20-byte Ethereum addresses)
-- Tables marked [bootstrap] are populated by the Dune API cold start

-- [bootstrap] Daily and PvP game instances
CREATE TABLE games (
    id           TEXT PRIMARY KEY,
    game_type    TEXT NOT NULL DEFAULT 'daily',
    word_index   INTEGER NOT NULL,
    salt         TEXT,
    commitment   TEXT,
    status       TEXT NOT NULL DEFAULT 'active',
    capacity     INTEGER,
    token        TEXT,
    amount       TEXT,
    timeout_secs INTEGER,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_games_type_status ON games(game_type, status);

-- [bootstrap] Registered players (one row per unique wallet)
CREATE TABLE players (
    id         BIGSERIAL PRIMARY KEY,
    address    BYTEA NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- [bootstrap] Individual guess attempts
CREATE TABLE guesses (
    id           BIGSERIAL PRIMARY KEY,
    game_id      TEXT NOT NULL REFERENCES games(id),
    player_id    BIGINT NOT NULL REFERENCES players(id),
    guess_number INTEGER NOT NULL,
    word         TEXT NOT NULL,
    results      TEXT NOT NULL,
    is_correct   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(game_id, player_id, guess_number)
);

CREATE INDEX idx_guesses_game_player ON guesses(game_id, player_id);

-- Player participation in a game (tracks progress and outcome)
CREATE TABLE game_players (
    game_id     TEXT NOT NULL REFERENCES games(id),
    player_id   BIGINT NOT NULL REFERENCES players(id),
    address     BYTEA NOT NULL,
    started_at  TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    solved      BOOLEAN NOT NULL DEFAULT FALSE,
    guess_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (game_id, player_id)
);

CREATE INDEX idx_game_players_game ON game_players(game_id);

-- [bootstrap] On-chain event indexer bookmark (singleton row)
CREATE TABLE indexer_cursor (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    block_number BIGINT NOT NULL DEFAULT 0,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
