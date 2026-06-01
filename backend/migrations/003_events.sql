-- Telemetry events for measuring activity (hackathon Criterion 5: weekly unique
-- wallets opening the mini-app inside the Circles app).
CREATE TABLE events (
    id     BIGSERIAL PRIMARY KEY,
    wallet BYTEA NOT NULL,
    kind   TEXT NOT NULL,
    ts     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_events_kind_ts ON events(kind, ts);
CREATE INDEX idx_events_wallet_ts ON events(wallet, ts);
