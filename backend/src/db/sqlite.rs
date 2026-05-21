use super::models::{DailyResult, GameRecord, GuessRecord, LeaderboardEntry, PlayerRecord};
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
        conn.execute_batch(include_str!("migrations/001_initial.sql"))
            .map_err(|e| RepositoryError::Internal(e.to_string()))?;
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
                "INSERT INTO games (id, game_type, word_index, salt, commitment, status) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![game.id, game.game_type, game.word_index, game.salt, game.commitment, game.status],
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
                .prepare("SELECT id, game_type, word_index, salt, commitment, status, created_at FROM games WHERE id = ?1")
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
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_repo() -> SqliteRepository {
        SqliteRepository::new(":memory:").unwrap()
    }

    #[tokio::test]
    async fn create_and_get_game() {
        let repo = test_repo();
        let game = GameRecord {
            id: "42".into(),
            game_type: "daily".into(),
            word_index: 100,
            salt: None,
            commitment: None,
            status: "active".into(),
            created_at: String::new(),
        };
        repo.create_game(&game).await.unwrap();

        let fetched = repo.get_game("42").await.unwrap().unwrap();
        assert_eq!(fetched.id, "42");
        assert_eq!(fetched.word_index, 100);
        assert_eq!(fetched.status, "active");
    }

    #[tokio::test]
    async fn duplicate_game_returns_conflict() {
        let repo = test_repo();
        let game = GameRecord {
            id: "1".into(),
            game_type: "daily".into(),
            word_index: 0,
            salt: None,
            commitment: None,
            status: "active".into(),
            created_at: String::new(),
        };
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
        let game = GameRecord {
            id: "10".into(),
            game_type: "daily".into(),
            word_index: 50,
            salt: None,
            commitment: None,
            status: "active".into(),
            created_at: String::new(),
        };
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
        let game = GameRecord {
            id: "5".into(),
            game_type: "daily".into(),
            word_index: 25,
            salt: None,
            commitment: None,
            status: "active".into(),
            created_at: String::new(),
        };
        repo.create_game(&game).await.unwrap();
        repo.update_game_status("5", "completed").await.unwrap();

        let fetched = repo.get_game("5").await.unwrap().unwrap();
        assert_eq!(fetched.status, "completed");
    }
}
