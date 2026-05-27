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
    let normalized = format!("{:0>40}", stripped.to_lowercase());
    hex::decode(&normalized).expect("invalid hex address")
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

    pub fn from_pool(pool: PgPool) -> Self {
        Self { pool }
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
            String,
            String,
            i32,
            Option<String>,
            Option<String>,
            String,
            String,
            Option<i32>,
            Option<String>,
            Option<String>,
            Option<i32>,
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

        let row: (i64, Vec<u8>, String) =
            sqlx::query_as("SELECT id, address, created_at::text FROM players WHERE address = $1")
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
                    )::float8 AS avg_guesses
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
        let rows: Vec<(Vec<u8>, i32, bool)> = sqlx::query_as(
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
            String,
            String,
            i32,
            Option<String>,
            Option<String>,
            String,
            String,
            Option<i32>,
            Option<String>,
            Option<String>,
            Option<i32>,
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

    async fn get_games_by_player(
        &self,
        address: &str,
        active_only: bool,
    ) -> Result<Vec<GameRecord>, RepositoryError> {
        let bytes = decode_address(address);
        let rows: Vec<(
            String,
            String,
            i32,
            Option<String>,
            Option<String>,
            String,
            String,
            Option<i32>,
            Option<String>,
            Option<String>,
            Option<i32>,
        )> = sqlx::query_as(
            "SELECT g.id, g.game_type, g.word_index, g.salt, g.commitment, g.status,
                    g.created_at::text, g.capacity, g.token, g.amount, g.timeout_secs
             FROM game_players gp
             JOIN games g ON g.id = gp.game_id
             WHERE gp.address = $1 AND g.game_type = 'pvp'
               AND ($2 = false OR g.status IN ('waiting', 'active'))
             ORDER BY g.created_at DESC
             LIMIT 20",
        )
        .bind(&bytes)
        .bind(active_only)
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

#[cfg(test)]
mod tests {
    use super::super::models::*;
    use super::super::repository::*;
    use super::*;
    use sqlx::PgPool;

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

    #[sqlx::test(migrations = "./migrations")]
    async fn create_and_get_game(pool: PgPool) {
        let repo = PostgresRepository::from_pool(pool);
        let game = daily_game("42", 100);
        repo.create_game(&game).await.unwrap();

        let fetched = repo.get_game("42").await.unwrap().unwrap();
        assert_eq!(fetched.id, "42");
        assert_eq!(fetched.word_index, 100);
        assert_eq!(fetched.status, "active");
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn duplicate_game_returns_conflict(pool: PgPool) {
        let repo = PostgresRepository::from_pool(pool);
        let game = daily_game("1", 0);
        repo.create_game(&game).await.unwrap();
        let err = repo.create_game(&game).await.unwrap_err();
        assert!(matches!(err, RepositoryError::Conflict(_)));
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn get_or_create_player(pool: PgPool) {
        let repo = PostgresRepository::from_pool(pool);
        let p1 = repo.get_or_create_player("0xabc").await.unwrap();
        let p2 = repo.get_or_create_player("0xabc").await.unwrap();
        assert_eq!(p1.id, p2.id);
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn record_and_retrieve_guesses(pool: PgPool) {
        let repo = PostgresRepository::from_pool(pool);
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

    #[sqlx::test(migrations = "./migrations")]
    async fn update_game_status(pool: PgPool) {
        let repo = PostgresRepository::from_pool(pool);
        let game = daily_game("5", 25);
        repo.create_game(&game).await.unwrap();
        repo.update_game_status("5", "completed").await.unwrap();

        let fetched = repo.get_game("5").await.unwrap().unwrap();
        assert_eq!(fetched.status, "completed");
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn pvp_game_with_players(pool: PgPool) {
        let repo = PostgresRepository::from_pool(pool);
        let game = pvp_game("0xgame1");
        repo.create_game(&game).await.unwrap();

        let p1 = repo
            .get_or_create_player("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            .await
            .unwrap();
        let p2 = repo
            .get_or_create_player("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
            .await
            .unwrap();

        repo.add_game_player(
            "0xgame1",
            p1.id,
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .await
        .unwrap();
        repo.add_game_player(
            "0xgame1",
            p2.id,
            "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        )
        .await
        .unwrap();

        let players = repo.get_game_players("0xgame1").await.unwrap();
        assert_eq!(players.len(), 2);
        assert!(players[0].started_at.is_none());
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn pvp_player_lifecycle(pool: PgPool) {
        let repo = PostgresRepository::from_pool(pool);
        let game = pvp_game("0xgame2");
        repo.create_game(&game).await.unwrap();

        let p = repo
            .get_or_create_player("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            .await
            .unwrap();
        repo.add_game_player(
            "0xgame2",
            p.id,
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
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

    #[sqlx::test(migrations = "./migrations")]
    async fn update_game_pvp_fields(pool: PgPool) {
        let repo = PostgresRepository::from_pool(pool);
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

    #[sqlx::test(migrations = "./migrations")]
    async fn add_game_player_idempotent(pool: PgPool) {
        let repo = PostgresRepository::from_pool(pool);
        let game = pvp_game("0xgame4");
        repo.create_game(&game).await.unwrap();
        let p = repo
            .get_or_create_player("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
            .await
            .unwrap();

        repo.add_game_player(
            "0xgame4",
            p.id,
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .await
        .unwrap();
        repo.add_game_player(
            "0xgame4",
            p.id,
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .await
        .unwrap();

        let players = repo.get_game_players("0xgame4").await.unwrap();
        assert_eq!(players.len(), 1);
    }

    #[sqlx::test(migrations = "./migrations")]
    async fn get_games_by_player_filters(pool: PgPool) {
        let repo = PostgresRepository::from_pool(pool);
        let addr = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

        let mut waiting = pvp_game("0xwaiting");
        waiting.status = "waiting".into();
        repo.create_game(&waiting).await.unwrap();

        let mut settled = pvp_game("0xsettled");
        settled.status = "settled".into();
        repo.create_game(&settled).await.unwrap();

        // A daily game the same address plays — must never be returned.
        repo.create_game(&daily_game("99", 0)).await.unwrap();

        let p = repo.get_or_create_player(addr).await.unwrap();
        repo.add_game_player("0xwaiting", p.id, addr).await.unwrap();
        repo.add_game_player("0xsettled", p.id, addr).await.unwrap();
        repo.add_game_player("99", p.id, addr).await.unwrap();

        let all = repo.get_games_by_player(addr, false).await.unwrap();
        assert_eq!(all.len(), 2, "both pvp games, daily excluded");
        assert!(all.iter().all(|g| g.game_type == "pvp"));

        let active = repo.get_games_by_player(addr, true).await.unwrap();
        assert_eq!(active.len(), 1, "only the waiting game is in progress");
        assert_eq!(active[0].id, "0xwaiting");

        let other = repo
            .get_games_by_player("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", false)
            .await
            .unwrap();
        assert!(other.is_empty());
    }
}
