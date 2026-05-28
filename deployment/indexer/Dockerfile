FROM ghcr.io/joshstevens19/rindexer:latest
# rindexer config + ABIs live in an image-only path so package rebuilds always
# win (no named-volume seeding gotcha). rindexer writes its event tables into
# the shared Postgres via DATABASE_URL — no SQLite, no /data volume needed.
COPY rindexer.yaml /etc/rindexer/rindexer.yaml
COPY abis/ /etc/rindexer/abis/
WORKDIR /etc/rindexer
