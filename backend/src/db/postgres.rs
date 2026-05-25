use super::models::{
    DailyResult, GamePlayerRecord, GameRecord, GuessRecord, LeaderboardEntry, PlayerRecord,
};
use super::repository::{GameRepository, RepositoryError};
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;

#[derive(Clone)]
pub struct PostgresRepository {
    pool: PgPool,
}

fn decode_address(hex_str: &str) -> Vec<u8> {
    let stripped = hex_str.strip_prefix("0x").unwrap_or(hex_str);
    hex::decode(stripped.to_lowercase()).unwrap_or_default()
}

fn encode_address(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

impl PostgresRepository {
    pub async fn new(database_url: &str) -> Result<Self, RepositoryError> {
        let pool = PgPoolOptions::new()
            .max_connections(10)
            .connect(database_url)
            .await
            .map_err(|e| RepositoryError::Internal(e.to_string()))?;

        sqlx::migrate!("./migrations")
            .run(&pool)
            .await
            .map_err(|e| RepositoryError::Internal(e.to_string()))?;

        Ok(Self { pool })
    }
}

impl GameRepository for PostgresRepository {
    async fn create_game(&self, game: &GameRecord) -> Result<(), RepositoryError> {
        sqlx::query(
            "INSERT INTO games (id, game_type, word_index, salt, commitment, status, capacity, token, amount, timeout_secs)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
        )
        .bind(&game.id)
        .bind(&game.game_type)
        .bind(game.word_index as i32)
        .bind(&game.salt)
        .bind(&game.commitment)
        .bind(&game.status)
        .bind(game.capacity.map(|v| v as i32))
        .bind(&game.token)
        .bind(&game.amount)
        .bind(game.timeout_secs.map(|v| v as i32))
        .execute(&self.pool)
        .await
        .map_err(|e| {
            if is_unique_violation(&e) {
                return RepositoryError::Conflict("game already exists".into());
            }
            RepositoryError::Internal(e.to_string())
        })?;
        Ok(())
    }

    async fn get_game(&self, game_id: &str) -> Result<Option<GameRecord>, RepositoryError> {
        let row: Option<(
            String, String, i32, Option<String>, Option<String>, String, String,
            Option<i32>, Option<String>, Option<String>, Option<i32>,
        )> = sqlx::query_as(
            "SELECT id, game_type, word_index, salt, commitment, status, created_at::text,
                    capacity, token, amount, timeout_secs
             FROM games WHERE id = $1",
        )
        .bind(game_id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?;

        Ok(row.map(|r| GameRecord {
            id: r.0,
            game_type: r.1,
            word_index: r.2 as usize,
            salt: r.3,
            commitment: r.4,
            status: r.5,
            created_at: r.6,
            capacity: r.7.map(|v| v as u32),
            token: r.8,
            amount: r.9,
            timeout_secs: r.10.map(|v| v as u32),
        }))
    }

    async fn update_game_status(&self, game_id: &str, status: &str) -> Result<(), RepositoryError> {
        let result = sqlx::query("UPDATE games SET status = $1 WHERE id = $2")
            .bind(status)
            .bind(game_id)
            .execute(&self.pool)
            .await
            .map_err(|e| RepositoryError::Internal(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(RepositoryError::NotFound);
        }
        Ok(())
    }

    async fn get_or_create_player(&self, address: &str) -> Result<PlayerRecord, RepositoryError> {
        let bytes = decode_address(address);

        sqlx::query("INSERT INTO players (address) VALUES ($1) ON CONFLICT DO NOTHING")
            .bind(&bytes)
            .execute(&self.pool)
            .await
            .map_err(|e| RepositoryError::Internal(e.to_string()))?;

        let row: (i64, Vec<u8>, String) = sqlx::query_as(
            "SELECT id, address, created_at::text FROM players WHERE address = $1",
        )
        .bind(&bytes)
        .fetch_one(&self.pool)
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?;

        Ok(PlayerRecord {
            id: row.0,
            address: encode_address(&row.1),
            created_at: row.2,
        })
    }

    async fn record_guess(&self, guess: &GuessRecord) -> Result<(), RepositoryError> {
        sqlx::query(
            "INSERT INTO guesses (game_id, player_id, guess_number, word, results, is_correct)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(&guess.game_id)
        .bind(guess.player_id)
        .bind(guess.guess_number as i32)
        .bind(&guess.word)
        .bind(&guess.results)
        .bind(guess.is_correct)
        .execute(&self.pool)
        .await
        .map_err(|e| {
            if is_unique_violation(&e) {
                return RepositoryError::Conflict("duplicate guess".into());
            }
            RepositoryError::Internal(e.to_string())
        })?;
        Ok(())
    }

    async fn get_guesses(
        &self,
        game_id: &str,
        player_id: i64,
    ) -> Result<Vec<GuessRecord>, RepositoryError> {
        let rows: Vec<(i64, String, i64, i32, String, String, bool, String)> = sqlx::query_as(
            "SELECT id, game_id, player_id, guess_number, word, results, is_correct, created_at::text
             FROM guesses WHERE game_id = $1 AND player_id = $2 ORDER BY guess_number",
        )
        .bind(game_id)
        .bind(player_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?;

        Ok(rows
            .into_iter()
            .map(|r| GuessRecord {
                id: Some(r.0),
                game_id: r.1,
                player_id: r.2,
                guess_number: r.3 as u32,
                word: r.4,
                results: r.5,
                is_correct: r.6,
                created_at: Some(r.7),
            })
            .collect())
    }

    async fn get_guess_count(&self, game_id: &str, player_id: i64) -> Result<u32, RepositoryError> {
        let row: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM guesses WHERE game_id = $1 AND player_id = $2")
                .bind(game_id)
                .bind(player_id)
                .fetch_one(&self.pool)
                .await
                .map_err(|e| RepositoryError::Internal(e.to_string()))?;

        Ok(row.0 as u32)
    }

    async fn get_leaderboard(
        &self,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<LeaderboardEntry>, RepositoryError> {
        let rows: Vec<(Vec<u8>, i64, i64, f64)> = sqlx::query_as(
            "SELECT p.address,
                    SUM(CASE WHEN g.is_correct THEN 1 ELSE 0 END) AS wins,
                    COUNT(DISTINCT g.game_id) AS games_played,
                    COALESCE(
                        AVG(CASE WHEN g.is_correct THEN g.guess_number + 1 END),
                        0.0
                    ) AS avg_guesses
             FROM guesses g
             JOIN players p ON p.id = g.player_id
             GROUP BY p.address
             ORDER BY wins DESC, avg_guesses ASC, games_played DESC
             LIMIT $1 OFFSET $2",
        )
        .bind(limit as i64)
        .bind(offset as i64)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?;

        Ok(rows
            .into_iter()
            .map(|r| LeaderboardEntry {
                address: encode_address(&r.0),
                wins: r.1 as u32,
                games_played: r.2 as u32,
                avg_guesses: r.3,
            })
            .collect())
    }

    async fn get_daily_results(&self, game_id: &str) -> Result<Vec<DailyResult>, RepositoryError> {
        let rows: Vec<(Vec<u8>, i64, bool)> = sqlx::query_as(
            "SELECT p.address,
                    MAX(g.guess_number) + 1 AS guesses,
                    BOOL_OR(g.is_correct) AS solved
             FROM guesses g
             JOIN players p ON p.id = g.player_id
             WHERE g.game_id = $1
             GROUP BY p.address
             ORDER BY solved DESC, guesses ASC",
        )
        .bind(game_id)
        .fetch_all(&self.pool)
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?;

        Ok(rows
            .into_iter()
            .map(|r| DailyResult {
                address: encode_address(&r.0),
                guesses: r.1 as u32,
                solved: r.2,
            })
            .collect())
    }

    async fn get_indexer_cursor(&self) -> Result<u64, RepositoryError> {
        let row: Option<(i64,)> =
            sqlx::query_as("SELECT block_number FROM indexer_cursor WHERE id = 1")
                .fetch_optional(&self.pool)
                .await
                .map_err(|e| RepositoryError::Internal(e.to_string()))?;

        Ok(row.map(|r| r.0 as u64).unwrap_or(0))
    }

    async fn set_indexer_cursor(&self, block_number: u64) -> Result<(), RepositoryError> {
        sqlx::query(
            "INSERT INTO indexer_cursor (id, block_number) VALUES (1, $1)
             ON CONFLICT(id) DO UPDATE SET block_number = $1, updated_at = NOW()",
        )
        .bind(block_number as i64)
        .execute(&self.pool)
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?;
        Ok(())
    }

    async fn add_game_player(
        &self,
        game_id: &str,
        player_id: i64,
        address: &str,
    ) -> Result<(), RepositoryError> {
        let bytes = decode_address(address);

        sqlx::query(
            "INSERT INTO game_players (game_id, player_id, address) VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING",
        )
        .bind(game_id)
        .bind(player_id)
        .bind(&bytes)
        .execute(&self.pool)
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?;
        Ok(())
    }

    async fn get_game_players(
        &self,
        game_id: &str,
    ) -> Result<Vec<GamePlayerRecord>, RepositoryError> {
        let rows: Vec<(String, i64, Vec<u8>, Option<String>, Option<String>, bool, i32)> =
            sqlx::query_as(
                "SELECT game_id, player_id, address, started_at::text, finished_at::text, solved, guess_count
                 FROM game_players WHERE game_id = $1",
            )
            .bind(game_id)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| RepositoryError::Internal(e.to_string()))?;

        Ok(rows
            .into_iter()
            .map(|r| GamePlayerRecord {
                game_id: r.0,
                player_id: r.1,
                address: encode_address(&r.2),
                started_at: r.3,
                finished_at: r.4,
                solved: r.5,
                guess_count: r.6 as u32,
            })
            .collect())
    }

    async fn update_game_player_started(
        &self,
        game_id: &str,
        player_id: i64,
    ) -> Result<(), RepositoryError> {
        sqlx::query(
            "UPDATE game_players SET started_at = NOW()
             WHERE game_id = $1 AND player_id = $2 AND started_at IS NULL",
        )
        .bind(game_id)
        .bind(player_id)
        .execute(&self.pool)
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?;
        Ok(())
    }

    async fn update_game_player_finished(
        &self,
        game_id: &str,
        player_id: i64,
        solved: bool,
        guess_count: u32,
    ) -> Result<(), RepositoryError> {
        sqlx::query(
            "UPDATE game_players SET finished_at = NOW(), solved = $3, guess_count = $4
             WHERE game_id = $1 AND player_id = $2",
        )
        .bind(game_id)
        .bind(player_id)
        .bind(solved)
        .bind(guess_count as i32)
        .execute(&self.pool)
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?;
        Ok(())
    }

    async fn update_game_pvp_fields(
        &self,
        game_id: &str,
        word_index: usize,
        salt: &str,
        commitment: &str,
        status: &str,
    ) -> Result<(), RepositoryError> {
        let result = sqlx::query(
            "UPDATE games SET word_index = $2, salt = $3, commitment = $4, status = $5
             WHERE id = $1",
        )
        .bind(game_id)
        .bind(word_index as i32)
        .bind(salt)
        .bind(commitment)
        .bind(status)
        .execute(&self.pool)
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?;

        if result.rows_affected() == 0 {
            return Err(RepositoryError::NotFound);
        }
        Ok(())
    }

    async fn get_active_pvp_games(&self) -> Result<Vec<GameRecord>, RepositoryError> {
        let rows: Vec<(
            String, String, i32, Option<String>, Option<String>, String, String,
            Option<i32>, Option<String>, Option<String>, Option<i32>,
        )> = sqlx::query_as(
            "SELECT id, game_type, word_index, salt, commitment, status, created_at::text,
                    capacity, token, amount, timeout_secs
             FROM games
             WHERE game_type = 'pvp' AND status = 'active'",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| RepositoryError::Internal(e.to_string()))?;

        Ok(rows
            .into_iter()
            .map(|r| GameRecord {
                id: r.0,
                game_type: r.1,
                word_index: r.2 as usize,
                salt: r.3,
                commitment: r.4,
                status: r.5,
                created_at: r.6,
                capacity: r.7.map(|v| v as u32),
                token: r.8,
                amount: r.9,
                timeout_secs: r.10.map(|v| v as u32),
            })
            .collect())
    }
}

fn is_unique_violation(e: &sqlx::Error) -> bool {
    if let sqlx::Error::Database(db_err) = e {
        return db_err.code().as_deref() == Some("23505");
    }
    false
}
