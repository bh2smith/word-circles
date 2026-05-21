CREATE TABLE IF NOT EXISTS indexer_cursor (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    block_number INTEGER NOT NULL DEFAULT 0,
    updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
