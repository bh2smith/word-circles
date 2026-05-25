use super::models::{
    DailyResult, GamePlayerRecord, GameRecord, GuessRecord, LeaderboardEntry, PlayerRecord,
};
use super::repository::{GameRepository, RepositoryError};
use rusqlite::{Connection, OptionalExtension, params};
use std::sync::{Arc, Mutex};

pub struct SqliteRepository {
    conn: Arc<Mutex<Connection>>,
}

impl SqliteRepository {
    pub fn new(path: &str) -> Result<Self, RepositoryError> {
        let conn = Connection::open(path).map_err(|e| RepositoryError::Internal(e.to_string()))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(|e| RepositoryError::Internal(e.to_string()))?;

        let repo = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        repo.run_migrations()?;
        Ok(repo)
    }

    fn run_migrations(&self) -> Result<(), RepositoryError> {
        let conn = self.conn.lock().unwrap();

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            )",
        )
        .map_err(|e| RepositoryError::Internal(e.to_string()))?;

        let migrations: &[(i64, &str)] = &[
            (1, include_str!("migrations/001_initial.sql")),
            (2, include_str!("migrations/002_indexer.sql")),
            (3, include_str!("migrations/003_pvp.sql")),
        ];

        for &(version, sql) in migrations {
            let applied: bool = conn
                .query_row(
                    "SELECT COUNT(*) > 0 FROM schema_migrations WHERE version = ?1",
                    params![version],
                    |row| row.get(0),
                )
                .map_err(|e| RepositoryError::Internal(e.to_string()))?;

            if !applied {
                conn.execute_batch(sql)
                    .map_err(|e| RepositoryError::Internal(e.to_string()))?;
                conn.execute(
                    "INSERT INTO schema_migrations (version) VALUES (?1)",
                    params![version],
                )
                .map_err(|e| RepositoryError::Internal(e.to_string()))?;
                tracing::info!("Applied migration {version}");
            }
        }

        Ok(())
    }
}

impl GameRepository for SqliteRepository {
    async fn create_game(&self, game: &GameRecord) -> Result<(), RepositoryError> {
        let conn = self.conn.clone();
        let game = game.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            conn.execute(
                "INSERT INTO games (id, game_type, word_index, salt, commitment, status, capacity, token, amount, timeout_secs)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    game.id, game.game_type, game.word_index, game.salt, game.commitment, game.status,
                    game.capacity, game.token, game.amount, game.timeout_secs,
                ],
            )
            .map_err(|e| {
                if let rusqlite::Error::SqliteFailure(err, _) = &e {
                    if err.code == rusqlite::ErrorCode::ConstraintViolation {
                        return RepositoryError::Conflict("game already exists".into());
                    }
                }
                RepositoryError::Internal(e.to_string())
            })?;
            Ok(())
        })
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?
    }

    async fn get_game(&self, game_id: &str) -> Result<Option<GameRecord>, RepositoryError> {
        let conn = self.conn.clone();
        let game_id = game_id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let mut stmt = conn
                .prepare(
                    "SELECT id, game_type, word_index, salt, commitment, status, created_at,
                            capacity, token, amount, timeout_secs
                     FROM games WHERE id = ?1",
                )
                .map_err(|e| RepositoryError::Internal(e.to_string()))?;

            let result = stmt
                .query_row(params![game_id], |row| {
                    Ok(GameRecord {
                        id: row.get(0)?,
                        game_type: row.get(1)?,
                        word_index: row.get::<_, i64>(2)? as usize,
                        salt: row.get(3)?,
                        commitment: row.get(4)?,
                        status: row.get(5)?,
                        created_at: row.get(6)?,
                        capacity: row.get::<_, Option<i64>>(7)?.map(|v| v as u32),
                        token: row.get(8)?,
                        amount: row.get(9)?,
                        timeout_secs: row.get::<_, Option<i64>>(10)?.map(|v| v as u32),
                    })
                })
                .optional()
                .map_err(|e| RepositoryError::Internal(e.to_string()))?;

            Ok(result)
        })
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?
    }

    async fn update_game_status(&self, game_id: &str, status: &str) -> Result<(), RepositoryError> {
        let conn = self.conn.clone();
        let game_id = game_id.to_string();
        let status = status.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let rows = conn
                .execute(
                    "UPDATE games SET status = ?1 WHERE id = ?2",
                    params![status, game_id],
                )
                .map_err(|e| RepositoryError::Internal(e.to_string()))?;
            if rows == 0 {
                return Err(RepositoryError::NotFound);
            }
            Ok(())
        })
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?
    }

    async fn get_or_create_player(&self, address: &str) -> Result<PlayerRecord, RepositoryError> {
        let conn = self.conn.clone();
        let address = address.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            conn.execute(
                "INSERT OR IGNORE INTO players (address) VALUES (?1)",
                params![address],
            )
            .map_err(|e| RepositoryError::Internal(e.to_string()))?;

            conn.query_row(
                "SELECT id, address, created_at FROM players WHERE address = ?1",
                params![address],
                |row| {
                    Ok(PlayerRecord {
                        id: row.get(0)?,
                        address: row.get(1)?,
                        created_at: row.get(2)?,
                    })
                },
            )
            .map_err(|e| RepositoryError::Internal(e.to_string()))
        })
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?
    }

    async fn record_guess(&self, guess: &GuessRecord) -> Result<(), RepositoryError> {
        let conn = self.conn.clone();
        let guess = guess.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            conn.execute(
                "INSERT INTO guesses (game_id, player_id, guess_number, word, results, is_correct) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![guess.game_id, guess.player_id, guess.guess_number, guess.word, guess.results, guess.is_correct as i32],
            )
            .map_err(|e| {
                if let rusqlite::Error::SqliteFailure(err, _) = &e {
                    if err.code == rusqlite::ErrorCode::ConstraintViolation {
                        return RepositoryError::Conflict("duplicate guess".into());
                    }
                }
                RepositoryError::Internal(e.to_string())
            })?;
            Ok(())
        })
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?
    }

    async fn get_guesses(
        &self,
        game_id: &str,
        player_id: i64,
    ) -> Result<Vec<GuessRecord>, RepositoryError> {
        let conn = self.conn.clone();
        let game_id = game_id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let mut stmt = conn
                .prepare("SELECT id, game_id, player_id, guess_number, word, results, is_correct, created_at FROM guesses WHERE game_id = ?1 AND player_id = ?2 ORDER BY guess_number")
                .map_err(|e| RepositoryError::Internal(e.to_string()))?;

            let rows = stmt
                .query_map(params![game_id, player_id], |row| {
                    Ok(GuessRecord {
                        id: Some(row.get(0)?),
                        game_id: row.get(1)?,
                        player_id: row.get(2)?,
                        guess_number: row.get::<_, u32>(3)?,
                        word: row.get(4)?,
                        results: row.get(5)?,
                        is_correct: row.get::<_, i32>(6)? != 0,
                        created_at: Some(row.get(7)?),
                    })
                })
                .map_err(|e| RepositoryError::Internal(e.to_string()))?;

            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| RepositoryError::Internal(e.to_string()))
        })
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?
    }

    async fn get_guess_count(&self, game_id: &str, player_id: i64) -> Result<u32, RepositoryError> {
        let conn = self.conn.clone();
        let game_id = game_id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            conn.query_row(
                "SELECT COUNT(*) FROM guesses WHERE game_id = ?1 AND player_id = ?2",
                params![game_id, player_id],
                |row| row.get::<_, u32>(0),
            )
            .map_err(|e| RepositoryError::Internal(e.to_string()))
        })
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?
    }

    async fn get_leaderboard(
        &self,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<LeaderboardEntry>, RepositoryError> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let mut stmt = conn
                .prepare(
                    "SELECT p.address,
                            SUM(CASE WHEN g.is_correct = 1 THEN 1 ELSE 0 END) AS wins,
                            COUNT(DISTINCT g.game_id) AS games_played,
                            COALESCE(
                                AVG(CASE WHEN g.is_correct = 1 THEN g.guess_number + 1 END),
                                0.0
                            ) AS avg_guesses
                     FROM guesses g
                     JOIN players p ON p.id = g.player_id
                     GROUP BY g.player_id
                     ORDER BY wins DESC, avg_guesses ASC, games_played DESC
                     LIMIT ?1 OFFSET ?2",
                )
                .map_err(|e| RepositoryError::Internal(e.to_string()))?;

            let rows = stmt
                .query_map(params![limit, offset], |row| {
                    Ok(LeaderboardEntry {
                        address: row.get(0)?,
                        wins: row.get(1)?,
                        games_played: row.get(2)?,
                        avg_guesses: row.get(3)?,
                    })
                })
                .map_err(|e| RepositoryError::Internal(e.to_string()))?;

            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| RepositoryError::Internal(e.to_string()))
        })
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?
    }

    async fn get_daily_results(&self, game_id: &str) -> Result<Vec<DailyResult>, RepositoryError> {
        let conn = self.conn.clone();
        let game_id = game_id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let mut stmt = conn
                .prepare(
                    "SELECT p.address,
                            MAX(g.guess_number) + 1 AS guesses,
                            MAX(g.is_correct) AS solved
                     FROM guesses g
                     JOIN players p ON p.id = g.player_id
                     WHERE g.game_id = ?1
                     GROUP BY g.player_id
                     ORDER BY solved DESC, guesses ASC",
                )
                .map_err(|e| RepositoryError::Internal(e.to_string()))?;

            let rows = stmt
                .query_map(params![game_id], |row| {
                    Ok(DailyResult {
                        address: row.get(0)?,
                        guesses: row.get(1)?,
                        solved: row.get::<_, i32>(2)? != 0,
                    })
                })
                .map_err(|e| RepositoryError::Internal(e.to_string()))?;

            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| RepositoryError::Internal(e.to_string()))
        })
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?
    }

    async fn get_indexer_cursor(&self) -> Result<u64, RepositoryError> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            conn.query_row(
                "SELECT block_number FROM indexer_cursor WHERE id = 1",
                [],
                |row| row.get::<_, u64>(0),
            )
            .optional()
            .map_err(|e| RepositoryError::Internal(e.to_string()))
            .map(|opt| opt.unwrap_or(0))
        })
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?
    }

    async fn set_indexer_cursor(&self, block_number: u64) -> Result<(), RepositoryError> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            conn.execute(
                "INSERT INTO indexer_cursor (id, block_number) VALUES (1, ?1)
                 ON CONFLICT(id) DO UPDATE SET block_number = ?1,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')",
                params![block_number],
            )
            .map_err(|e| RepositoryError::Internal(e.to_string()))?;
            Ok(())
        })
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?
    }

    async fn add_game_player(
        &self,
        game_id: &str,
        player_id: i64,
        address: &str,
    ) -> Result<(), RepositoryError> {
        let conn = self.conn.clone();
        let game_id = game_id.to_string();
        let address = address.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            conn.execute(
                "INSERT OR IGNORE INTO game_players (game_id, player_id, address) VALUES (?1, ?2, ?3)",
                params![game_id, player_id, address],
            )
            .map_err(|e| RepositoryError::Internal(e.to_string()))?;
            Ok(())
        })
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?
    }

    async fn get_game_players(
        &self,
        game_id: &str,
    ) -> Result<Vec<GamePlayerRecord>, RepositoryError> {
        let conn = self.conn.clone();
        let game_id = game_id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let mut stmt = conn
                .prepare(
                    "SELECT game_id, player_id, address, started_at, finished_at, solved, guess_count
                     FROM game_players WHERE game_id = ?1",
                )
                .map_err(|e| RepositoryError::Internal(e.to_string()))?;

            let rows = stmt
                .query_map(params![game_id], |row| {
                    Ok(GamePlayerRecord {
                        game_id: row.get(0)?,
                        player_id: row.get(1)?,
                        address: row.get(2)?,
                        started_at: row.get(3)?,
                        finished_at: row.get(4)?,
                        solved: row.get::<_, i32>(5)? != 0,
                        guess_count: row.get(6)?,
                    })
                })
                .map_err(|e| RepositoryError::Internal(e.to_string()))?;

            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| RepositoryError::Internal(e.to_string()))
        })
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?
    }

    async fn update_game_player_started(
        &self,
        game_id: &str,
        player_id: i64,
    ) -> Result<(), RepositoryError> {
        let conn = self.conn.clone();
        let game_id = game_id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            conn.execute(
                "UPDATE game_players SET started_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                 WHERE game_id = ?1 AND player_id = ?2 AND started_at IS NULL",
                params![game_id, player_id],
            )
            .map_err(|e| RepositoryError::Internal(e.to_string()))?;
            Ok(())
        })
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?
    }

    async fn update_game_player_finished(
        &self,
        game_id: &str,
        player_id: i64,
        solved: bool,
        guess_count: u32,
    ) -> Result<(), RepositoryError> {
        let conn = self.conn.clone();
        let game_id = game_id.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            conn.execute(
                "UPDATE game_players
                 SET finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                     solved = ?3, guess_count = ?4
                 WHERE game_id = ?1 AND player_id = ?2",
                params![game_id, player_id, solved as i32, guess_count],
            )
            .map_err(|e| RepositoryError::Internal(e.to_string()))?;
            Ok(())
        })
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?
    }

    async fn update_game_pvp_fields(
        &self,
        game_id: &str,
        word_index: usize,
        salt: &str,
        commitment: &str,
        status: &str,
    ) -> Result<(), RepositoryError> {
        let conn = self.conn.clone();
        let game_id = game_id.to_string();
        let salt = salt.to_string();
        let commitment = commitment.to_string();
        let status = status.to_string();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let rows = conn
                .execute(
                    "UPDATE games SET word_index = ?2, salt = ?3, commitment = ?4, status = ?5
                     WHERE id = ?1",
                    params![game_id, word_index, salt, commitment, status],
                )
                .map_err(|e| RepositoryError::Internal(e.to_string()))?;
            if rows == 0 {
                return Err(RepositoryError::NotFound);
            }
            Ok(())
        })
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?
    }

    async fn get_active_pvp_games(&self) -> Result<Vec<GameRecord>, RepositoryError> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || {
            let conn = conn.lock().unwrap();
            let mut stmt = conn
                .prepare(
                    "SELECT id, game_type, word_index, salt, commitment, status, created_at,
                            capacity, token, amount, timeout_secs
                     FROM games
                     WHERE game_type = 'pvp' AND status = 'active'",
                )
                .map_err(|e| RepositoryError::Internal(e.to_string()))?;

            let rows = stmt
                .query_map([], |row| {
                    Ok(GameRecord {
                        id: row.get(0)?,
                        game_type: row.get(1)?,
                        word_index: row.get::<_, i64>(2)? as usize,
                        salt: row.get(3)?,
                        commitment: row.get(4)?,
                        status: row.get(5)?,
                        created_at: row.get(6)?,
                        capacity: row.get::<_, Option<i64>>(7)?.map(|v| v as u32),
                        token: row.get(8)?,
                        amount: row.get(9)?,
                        timeout_secs: row.get::<_, Option<i64>>(10)?.map(|v| v as u32),
                    })
                })
                .map_err(|e| RepositoryError::Internal(e.to_string()))?;

            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| RepositoryError::Internal(e.to_string()))
        })
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_repo() -> SqliteRepository {
        SqliteRepository::new(":memory:").unwrap()
    }

    fn daily_game(id: &str, word_index: usize) -> GameRecord {
        GameRecord {
            id: id.into(),
            game_type: "daily".into(),
            word_index,
            salt: None,
            commitment: None,
            status: "active".into(),
            created_at: String::new(),
            capacity: None,
            token: None,
            amount: None,
            timeout_secs: None,
        }
    }

    fn pvp_game(id: &str) -> GameRecord {
        GameRecord {
            id: id.into(),
            game_type: "pvp".into(),
            word_index: 0,
            salt: None,
            commitment: None,
            status: "waiting".into(),
            created_at: String::new(),
            capacity: Some(2),
            token: Some("0xtoken".into()),
            amount: Some("10000000000000000000".into()),
            timeout_secs: Some(10800),
        }
    }

    #[tokio::test]
    async fn create_and_get_game() {
        let repo = test_repo();
        let game = daily_game("42", 100);
        repo.create_game(&game).await.unwrap();

        let fetched = repo.get_game("42").await.unwrap().unwrap();
        assert_eq!(fetched.id, "42");
        assert_eq!(fetched.word_index, 100);
        assert_eq!(fetched.status, "active");
    }

    #[tokio::test]
    async fn duplicate_game_returns_conflict() {
        let repo = test_repo();
        let game = daily_game("1", 0);
        repo.create_game(&game).await.unwrap();
        let err = repo.create_game(&game).await.unwrap_err();
        assert!(matches!(err, RepositoryError::Conflict(_)));
    }

    #[tokio::test]
    async fn get_or_create_player() {
        let repo = test_repo();
        let p1 = repo.get_or_create_player("0xabc").await.unwrap();
        let p2 = repo.get_or_create_player("0xabc").await.unwrap();
        assert_eq!(p1.id, p2.id);
    }

    #[tokio::test]
    async fn record_and_retrieve_guesses() {
        let repo = test_repo();
        let game = daily_game("10", 50);
        repo.create_game(&game).await.unwrap();
        let player = repo.get_or_create_player("0xdef").await.unwrap();

        let guess = GuessRecord {
            id: None,
            game_id: "10".into(),
            player_id: player.id,
            guess_number: 0,
            word: "crane".into(),
            results: r#"["correct","absent","present","absent","absent"]"#.into(),
            is_correct: false,
            created_at: None,
        };
        repo.record_guess(&guess).await.unwrap();

        let count = repo.get_guess_count("10", player.id).await.unwrap();
        assert_eq!(count, 1);

        let guesses = repo.get_guesses("10", player.id).await.unwrap();
        assert_eq!(guesses.len(), 1);
        assert_eq!(guesses[0].word, "crane");
    }

    #[tokio::test]
    async fn update_game_status() {
        let repo = test_repo();
        let game = daily_game("5", 25);
        repo.create_game(&game).await.unwrap();
        repo.update_game_status("5", "completed").await.unwrap();

        let fetched = repo.get_game("5").await.unwrap().unwrap();
        assert_eq!(fetched.status, "completed");
    }

    #[tokio::test]
    async fn pvp_game_with_players() {
        let repo = test_repo();
        let game = pvp_game("0xgame1");
        repo.create_game(&game).await.unwrap();

        let p1 = repo.get_or_create_player("0xplayer1").await.unwrap();
        let p2 = repo.get_or_create_player("0xplayer2").await.unwrap();

        repo.add_game_player("0xgame1", p1.id, "0xplayer1")
            .await
            .unwrap();
        repo.add_game_player("0xgame1", p2.id, "0xplayer2")
            .await
            .unwrap();

        let players = repo.get_game_players("0xgame1").await.unwrap();
        assert_eq!(players.len(), 2);
        assert!(players[0].started_at.is_none());
    }

    #[tokio::test]
    async fn pvp_player_lifecycle() {
        let repo = test_repo();
        let game = pvp_game("0xgame2");
        repo.create_game(&game).await.unwrap();

        let p = repo.get_or_create_player("0xplayer1").await.unwrap();
        repo.add_game_player("0xgame2", p.id, "0xplayer1")
            .await
            .unwrap();

        repo.update_game_player_started("0xgame2", p.id)
            .await
            .unwrap();
        let players = repo.get_game_players("0xgame2").await.unwrap();
        assert!(players[0].started_at.is_some());

        repo.update_game_player_finished("0xgame2", p.id, true, 4)
            .await
            .unwrap();
        let players = repo.get_game_players("0xgame2").await.unwrap();
        assert!(players[0].finished_at.is_some());
        assert!(players[0].solved);
        assert_eq!(players[0].guess_count, 4);
    }

    #[tokio::test]
    async fn update_game_pvp_fields() {
        let repo = test_repo();
        let game = pvp_game("0xgame3");
        repo.create_game(&game).await.unwrap();

        repo.update_game_pvp_fields("0xgame3", 42, "aabb", "ccdd", "active")
            .await
            .unwrap();
        let fetched = repo.get_game("0xgame3").await.unwrap().unwrap();
        assert_eq!(fetched.word_index, 42);
        assert_eq!(fetched.salt.as_deref(), Some("aabb"));
        assert_eq!(fetched.commitment.as_deref(), Some("ccdd"));
        assert_eq!(fetched.status, "active");
    }

    #[tokio::test]
    async fn add_game_player_idempotent() {
        let repo = test_repo();
        let game = pvp_game("0xgame4");
        repo.create_game(&game).await.unwrap();
        let p = repo.get_or_create_player("0xplayer1").await.unwrap();

        repo.add_game_player("0xgame4", p.id, "0xplayer1")
            .await
            .unwrap();
        repo.add_game_player("0xgame4", p.id, "0xplayer1")
            .await
            .unwrap();

        let players = repo.get_game_players("0xgame4").await.unwrap();
        assert_eq!(players.len(), 1);
    }
}
