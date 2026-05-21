# Word Circles Backend

Rust/Axum backend for the Word Circles game. Handles daily game creation, guess evaluation, and persistence via SQLite.

## Prerequisites

- Rust 1.85+ (`rustup update stable`)

## Run locally

```sh
cd backend
cargo run
```

The server starts on `http://localhost:3001`. SQLite database is created at `./word-circles.db` by default.

### Environment variables

| Variable        | Default           | Description               |
| --------------- | ----------------- | ------------------------- |
| `PORT`          | `3001`            | Server listen port        |
| `DATABASE_PATH` | `word-circles.db` | SQLite database file path |

## Run tests

```sh
cargo test
```

## API

### `GET /health`

Health check. Returns `ok`.

### `GET /api/game`

Get today's game ID. Creates the game record on first request.

```sh
curl http://localhost:3001/api/game
# {"gameId":506}
```

### `POST /api/guess`

Submit a guess. Returns letter-by-letter results.

```sh
curl -X POST http://localhost:3001/api/guess \
  -H 'Content-Type: application/json' \
  -d '{"guess":"crane","gameId":506,"guessNumber":0}'
# {"guess":"crane","results":["absent","present","absent","correct","absent"],"won":false,"gameOver":false}
```

Optional `player` field (wallet address) enables persistence:

```sh
curl -X POST http://localhost:3001/api/guess \
  -H 'Content-Type: application/json' \
  -d '{"guess":"crane","gameId":506,"guessNumber":0,"player":"0xabc"}'
```

## Docker

```sh
docker build -t word-circles-backend .
docker run -p 3001:3001 -v word-circles-data:/data word-circles-backend
```

## Smoke tests

Integration tests exercise the full HTTP stack (routing, handlers, database) using in-memory SQLite:

```sh
cargo test --test smoke
```
