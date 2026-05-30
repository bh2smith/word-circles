use crate::chain::ResolverClient;
use crate::db::models::{GameRecord, GuessRecord};
use crate::db::repository::{GameRepository, RepositoryError};
use crate::game;
use sqlx::{PgPool, Row};
use std::sync::Arc;
use std::time::Duration;

pub struct IndexerConfig {
    pub poll_interval: Duration,
    pub resolver: Option<Arc<ResolverClient>>,
    pub pvp_enabled: bool,
    pub pvp_timeout_secs: u32,
}

/// Polls arak's event tables for new on-chain events and reacts to them.
/// arak (the sidecar) handles RPC polling, event decoding, reorg safety, and
/// raw event storage into the shared Postgres. This loop just SELECTs from the
/// bare `public` event tables (created/joined/resolved/game_recorded) and
/// updates application state.
pub async fn run<R: GameRepository>(repo: Arc<R>, pool: PgPool, config: IndexerConfig) {
    let mut cursor = repo.get_indexer_cursor().await.unwrap_or(0);

    tracing::info!(
        cursor,
        "Event listener starting (polling arak Postgres tables)"
    );

    loop {
        let events = match read_new_events(&pool, cursor).await {
            Ok(events) => events,
            Err(e) => {
                tracing::warn!("Failed to read arak events: {e}");
                tokio::time::sleep(config.poll_interval).await;
                continue;
            }
        };

        for event in &events {
            match event {
                IndexedEvent::Created {
                    game_id,
                    block_number,
                    player,
                    capacity,
                    token,
                    amount,
                } => {
                    tracing::info!(game_id, block_number, player, capacity, "Created");
                    if config.pvp_enabled {
                        let cap: u32 = capacity.parse().unwrap_or(2);
                        let record = GameRecord {
                            id: game_id.clone(),
                            game_type: "pvp".into(),
                            word_index: 0,
                            salt: None,
                            commitment: None,
                            status: "waiting".into(),
                            created_at: String::new(),
                            capacity: Some(cap),
                            token: Some(token.clone()),
                            amount: Some(amount.clone()),
                            timeout_secs: Some(config.pvp_timeout_secs),
                        };
                        if let Err(e) = repo.create_game(&record).await {
                            match e {
                                RepositoryError::Conflict(_) => {}
                                _ => tracing::error!(game_id, "Failed to create PvP game: {e}"),
                            }
                        }
                    }
                }
                IndexedEvent::Joined {
                    game_id,
                    block_number,
                    player,
                    players,
                    capacity,
                } => {
                    tracing::info!(game_id, block_number, player, players, "Joined");
                    if config.pvp_enabled {
                        if let Ok(p) = repo.get_or_create_player(player).await {
                            let _ = repo.add_game_player(game_id, p.id, player).await;
                        }
                    }
                    if *players == *capacity && config.pvp_enabled {
                        let repo = Arc::clone(&repo);
                        let game_id = game_id.clone();
                        let resolver = config.resolver.clone();
                        tokio::spawn(async move {
                            prepare_pvp_game(repo, &game_id, resolver).await;
                        });
                    }
                }
                IndexedEvent::Resolved {
                    game_id,
                    block_number,
                } => {
                    tracing::info!(game_id, block_number, "Resolved");
                    if let Err(e) = repo.update_game_status(game_id, "completed").await {
                        tracing::error!(game_id, "Failed to mark game completed: {e}");
                    }
                }
                IndexedEvent::GameRecorded {
                    block_number,
                    player,
                    game_id,
                    won,
                    guesses,
                } => {
                    tracing::info!(player, game_id, won, guesses, block_number, "GameRecorded");
                    backfill_game_result(repo.as_ref(), *game_id, player, *won, *guesses).await;
                }
            }
        }

        if let Some(max_block) = events.iter().map(|e| e.block_number()).max() {
            if max_block > cursor {
                cursor = max_block;
                if let Err(e) = repo.set_indexer_cursor(cursor).await {
                    tracing::error!("Failed to update cursor: {e}");
                }
            }
        }

        tokio::time::sleep(config.poll_interval).await;
    }
}

#[derive(Debug)]
enum IndexedEvent {
    Created {
        game_id: String,
        block_number: u64,
        player: String,
        capacity: String,
        token: String,
        amount: String,
    },
    Joined {
        game_id: String,
        block_number: u64,
        player: String,
        players: i64,
        capacity: i64,
    },
    Resolved {
        game_id: String,
        block_number: u64,
    },
    GameRecorded {
        block_number: u64,
        player: String,
        game_id: u32,
        won: bool,
        guesses: u8,
    },
}

impl IndexedEvent {
    fn block_number(&self) -> u64 {
        match self {
            Self::Created { block_number, .. }
            | Self::Joined { block_number, .. }
            | Self::Resolved { block_number, .. }
            | Self::GameRecorded { block_number, .. } => *block_number,
        }
    }
}

/// Reads new events from arak's tables. Tables may not exist yet on first boot
/// (arak creates them on its first poll); per-query errors are logged at debug
/// and swallowed so the loop keeps trying.
///
/// arak names columns `{field}_{ordinal}`, lowercased (e.g. `gameId` → `gameid_0`),
/// stores `bytes32`/`address` as BYTEA and `uint*` as NUMERIC, and `block_number`
/// as BIGINT — so addresses/hashes are hex-encoded here and numerics cast to
/// text/bigint to match the existing `IndexedEvent` string/int fields.
async fn read_new_events(pool: &PgPool, cursor: u64) -> Result<Vec<IndexedEvent>, sqlx::Error> {
    let mut events = Vec::new();
    let cursor_i64 = cursor as i64;

    // Created — gameid_0/player_1/token_3 are BYTEA; amount_4/capacity_5 NUMERIC.
    match sqlx::query(
        "SELECT block_number,
                '0x' || encode(gameid_0, 'hex') AS game_id,
                '0x' || encode(player_1, 'hex') AS player,
                capacity_5::text AS capacity,
                '0x' || encode(token_3, 'hex') AS token,
                amount_4::text AS amount
         FROM created
         WHERE block_number > $1
         ORDER BY block_number, log_index",
    )
    .bind(cursor_i64)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => {
            for r in rows {
                events.push(IndexedEvent::Created {
                    block_number: r.get::<i64, _>("block_number") as u64,
                    game_id: r.get::<String, _>("game_id"),
                    player: trim_addr(r.get::<String, _>("player")),
                    capacity: r.get::<String, _>("capacity"),
                    token: trim_addr(r.get::<String, _>("token")),
                    amount: r.get::<String, _>("amount"),
                });
            }
        }
        Err(e) => tracing::debug!("read created events: {e}"),
    }

    // Joined — LEFT JOIN created to recover the lobby capacity (Joined event
    // itself doesn't carry it). Joined's player is player_2 (gameid_0, creator_1,
    // player_2, players_3); created's capacity is capacity_5.
    match sqlx::query(
        "SELECT j.block_number,
                '0x' || encode(j.gameid_0, 'hex') AS game_id,
                '0x' || encode(j.player_2, 'hex') AS player,
                j.players_3::bigint AS players,
                COALESCE(c.capacity_5::bigint, 0) AS capacity
         FROM joined j
         LEFT JOIN created c ON c.gameid_0 = j.gameid_0
         WHERE j.block_number > $1
         ORDER BY j.block_number, j.log_index",
    )
    .bind(cursor_i64)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => {
            for r in rows {
                events.push(IndexedEvent::Joined {
                    block_number: r.get::<i64, _>("block_number") as u64,
                    game_id: r.get::<String, _>("game_id"),
                    player: trim_addr(r.get::<String, _>("player")),
                    players: r.get::<i64, _>("players"),
                    capacity: r.get::<i64, _>("capacity"),
                });
            }
        }
        Err(e) => tracing::debug!("read joined events: {e}"),
    }

    match sqlx::query(
        "SELECT block_number,
                '0x' || encode(gameid_0, 'hex') AS game_id
         FROM resolved
         WHERE block_number > $1
         ORDER BY block_number, log_index",
    )
    .bind(cursor_i64)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => {
            for r in rows {
                events.push(IndexedEvent::Resolved {
                    block_number: r.get::<i64, _>("block_number") as u64,
                    game_id: r.get::<String, _>("game_id"),
                });
            }
        }
        Err(e) => tracing::debug!("read resolved events: {e}"),
    }

    // GameRecorded — player_0 BYTEA, gameid_1/guesses_3 NUMERIC, won_2 BOOL.
    match sqlx::query(
        "SELECT block_number,
                '0x' || encode(player_0, 'hex') AS player,
                gameid_1::bigint AS game_id,
                won_2 AS won,
                guesses_3::smallint AS guesses
         FROM game_recorded
         WHERE block_number > $1
         ORDER BY block_number, log_index",
    )
    .bind(cursor_i64)
    .fetch_all(pool)
    .await
    {
        Ok(rows) => {
            for r in rows {
                events.push(IndexedEvent::GameRecorded {
                    block_number: r.get::<i64, _>("block_number") as u64,
                    player: trim_addr(r.get::<String, _>("player")),
                    game_id: r.get::<i64, _>("game_id") as u32,
                    won: r.get::<bool, _>("won"),
                    guesses: r.get::<i16, _>("guesses") as u8,
                });
            }
        }
        Err(e) => tracing::debug!("read game_recorded events: {e}"),
    }

    events.sort_by_key(|e| e.block_number());
    Ok(events)
}

/// arak stores addresses as raw BYTEA; we hex-encode them in SQL (`'0x' ||
/// encode(...)`), so they arrive clean. Trim defensively anyway — cheap and
/// guards against any driver padding.
fn trim_addr(s: String) -> String {
    s.trim().to_string()
}

pub async fn backfill_game_result<R: GameRepository>(
    repo: &R,
    game_id: u32,
    player: &str,
    won: bool,
    guesses: u8,
) {
    let game_id_str = game_id.to_string();

    if let Ok(None) = repo.get_game(&game_id_str).await {
        let record = GameRecord {
            id: game_id_str.clone(),
            game_type: "daily".into(),
            word_index: game::answer_index(game_id),
            salt: None,
            commitment: None,
            status: "active".into(),
            created_at: String::new(),
            capacity: None,
            token: None,
            amount: None,
            timeout_secs: None,
        };
        let _ = repo.create_game(&record).await;
    }

    let player_record = match repo.get_or_create_player(player).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(player, game_id, "Failed to create player for backfill: {e}");
            return;
        }
    };

    let guess_number = if guesses > 0 { guesses as u32 - 1 } else { 0 };
    let guess = GuessRecord {
        id: None,
        game_id: game_id_str,
        player_id: player_record.id,
        guess_number,
        word: String::new(),
        results: String::new(),
        is_correct: won,
        created_at: None,
    };
    match repo.record_guess(&guess).await {
        Ok(()) => tracing::debug!(player, game_id, "Backfilled game result"),
        Err(RepositoryError::Conflict(_)) => {}
        Err(e) => tracing::warn!(player, game_id, "Failed to backfill result: {e}"),
    }
}

pub fn parse_game_id_bytes(game_id: &str) -> [u8; 32] {
    let stripped = game_id.trim_start_matches("0x");
    let mut buf = [0u8; 32];
    if let Ok(decoded) = hex::decode(stripped) {
        if decoded.len() == 32 {
            buf.copy_from_slice(&decoded);
        }
    }
    buf
}

async fn prepare_pvp_game<R: GameRepository>(
    repo: Arc<R>,
    game_id: &str,
    resolver: Option<Arc<ResolverClient>>,
) {
    let word_index = game::random_word_index();
    let salt = game::generate_salt();
    let game_id_bytes = parse_game_id_bytes(game_id);
    let commitment = game::compute_pvp_commitment(&game_id_bytes, word_index, &salt);

    match repo
        .update_game_pvp_fields(
            game_id,
            word_index,
            &hex::encode(salt),
            &hex::encode(commitment),
            "active",
        )
        .await
    {
        Ok(()) => {
            tracing::info!(
                game_id,
                word_index,
                commitment = hex::encode(commitment),
                "PvP game prepared"
            );
        }
        Err(e) => {
            tracing::error!(game_id, "Failed to prepare PvP game: {e}");
            return;
        }
    }

    let Some(resolver) = resolver else {
        tracing::warn!(
            game_id,
            "No resolver configured — skipping on-chain commitment"
        );
        return;
    };

    submit_commitment_with_retry(&resolver, game_id, game_id_bytes, commitment).await;
}

async fn submit_commitment_with_retry(
    resolver: &ResolverClient,
    game_id: &str,
    game_id_bytes: [u8; 32],
    commitment: [u8; 32],
) {
    const MAX_RETRIES: u32 = 3;
    const BASE_DELAY: Duration = Duration::from_secs(2);

    for attempt in 0..=MAX_RETRIES {
        match resolver.commit(game_id_bytes, commitment).await {
            Ok(tx_hash) => {
                tracing::info!(game_id, %tx_hash, "Commitment submitted on-chain");
                return;
            }
            Err(e) => {
                if attempt == MAX_RETRIES {
                    tracing::error!(game_id, attempt, "Commitment failed after retries: {e}");
                } else {
                    tracing::warn!(
                        game_id,
                        attempt,
                        "Commitment attempt failed: {e}, retrying…"
                    );
                    tokio::time::sleep(BASE_DELAY * 2u32.pow(attempt)).await;
                }
            }
        }
    }
}
