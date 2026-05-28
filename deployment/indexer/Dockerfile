FROM ghcr.io/bh2smith/arak:main
# arak.toml lives OUTSIDE the named /data volume so future package rebuilds
# actually propagate config changes — Docker only seeds a named volume from
# the image on first start, so anything copied into /data is "stuck" thereafter.
# Only the SQLite DB (arak.db) needs to persist, and its absolute path inside
# arak.toml keeps it in the volume.
COPY arak.toml /etc/arak/arak.toml
