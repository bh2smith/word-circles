# Word Circles Backend

Rust/Axum backend for the Word Circles game. Handles daily game creation, guess evaluation, and persistence via PostgreSQL.

## Prerequisites

- Rust 1.85+ (`rustup update stable`)
- PostgreSQL 16+ (local install or Docker)

## Run locally

Start a local Postgres instance:

```sh
docker run -d --name wc-postgres \
  -e POSTGRES_USER=wordcircles \
  -e POSTGRES_PASSWORD=wordcircles \
  -e POSTGRES_DB=wordcircles \
  -p 5432:5432 \
  postgres:16
```

Then run the backend:

```sh
cd backend
DATABASE_URL=postgres://wordcircles:wordcircles@localhost:5432/wordcircles cargo run
```

Migrations run automatically on startup. The server starts on `http://localhost:3001`.

### Environment variables

| Variable       | Default | Description                             |
| -------------- | ------- | --------------------------------------- |
| `PORT`         | `3001`  | Server listen port                      |
| `DATABASE_URL` | —       | PostgreSQL connection string (required) |

## Run tests

Tests use `#[sqlx::test]` which automatically creates and tears down an isolated database per test. You need a running Postgres instance and `DATABASE_URL` set:

```sh
# Unit tests (postgres.rs)
DATABASE_URL=postgres://wordcircles:wordcircles@localhost:5432/wordcircles cargo test

# Smoke tests only (full HTTP stack)
DATABASE_URL=postgres://wordcircles:wordcircles@localhost:5432/wordcircles cargo test --test smoke
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
docker run -p 3001:3001 \
  -e DATABASE_URL=postgres://wordcircles:wordcircles@host.docker.internal:5432/wordcircles \
  word-circles-backend
```
