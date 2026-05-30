# Patched arak fork: includes the solabi FixedBytes(bytes32) decode fix and the
# Postgres BOOL column fix (GameRecorded.won). Pin the version tag you cut on
# bh2smith/arak (its deploy workflow only builds images on `v*` tags) — update
# this when you publish a new patched build.
FROM ghcr.io/bh2smith/arak:v0.3.1
# arak.toml is baked into /etc/arak (image-only path) so package rebuilds always
# propagate config changes. arak writes event tables straight into the shared
# Postgres via the connection string inside arak.toml — no SQLite, no /data volume.
COPY arak.toml /etc/arak/arak.toml
