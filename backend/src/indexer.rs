use crate::chain::ResolverClient;
use crate::db::models::GameRecord;
use crate::db::repository::GameRepository;
use crate::game;
use rusqlite::Connection;
use std::sync::Arc;
use std::time::Duration;

pub struct IndexerConfig {
    pub arak_db_path: String,
    pub poll_interval: Duration,
    pub resolver: Option<Arc<ResolverClient>>,
}

/// Polls arak's event tables for new on-chain events and reacts to them.
/// Arak (running as a sidecar) handles RPC polling, event decoding, reorg
/// safety, and raw event storage. This loop just reads from arak's SQLite
/// tables and updates application state accordingly.
pub async fn run<R: GameRepository>(repo: Arc<R>, config: IndexerConfig) {
    let mut cursor = repo.get_indexer_cursor().await.unwrap_or(0);

    tracing::info!(
        arak_db = %config.arak_db_path,
        cursor,
        "Event listener starting (polling arak tables)"
    );

    loop {
        let events = match read_new_events(&config.arak_db_path, cursor) {
            Ok(events) => events,
            Err(e) => {
                tracing::warn!("Failed to read arak events: {e}");
                tokio::time::sleep(config.poll_interval).await;
                continue;
            }
        };

        for event in &events {
            match event {
                ArakEvent::Created {
                    game_id,
                    block_number,
                    player,
                    capacity,
                    ..
                } => {
                    tracing::info!(game_id, block_number, player, capacity, "Created");
                }
                ArakEvent::Joined {
                    game_id,
                    block_number,
                    player,
                    players,
                    capacity,
                } => {
                    tracing::info!(game_id, block_number, player, players, "Joined");
                    if players == capacity {
                        let repo = Arc::clone(&repo);
                        let game_id = game_id.clone();
                        let resolver = config.resolver.clone();
                        tokio::spawn(async move {
                            prepare_pvp_game(repo, &game_id, resolver).await;
                        });
                    }
                }
                ArakEvent::Resolved {
                    game_id,
                    block_number,
                    ..
                } => {
                    tracing::info!(game_id, block_number, "Resolved");
                    if let Err(e) = repo.update_game_status(game_id, "completed").await {
                        tracing::error!(game_id, "Failed to mark game completed: {e}");
                    }
                }
                ArakEvent::GameRecorded {
                    block_number,
                    player,
                    game_id,
                    won,
                    guesses,
                } => {
                    tracing::info!(player, game_id, won, guesses, block_number, "GameRecorded");
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
enum ArakEvent {
    Created {
        game_id: String,
        block_number: u64,
        player: String,
        capacity: String,
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

impl ArakEvent {
    fn block_number(&self) -> u64 {
        match self {
            Self::Created { block_number, .. } => *block_number,
            Self::Joined { block_number, .. } => *block_number,
            Self::Resolved { block_number, .. } => *block_number,
            Self::GameRecorded { block_number, .. } => *block_number,
        }
    }
}

fn read_new_events(arak_db_path: &str, cursor: u64) -> Result<Vec<ArakEvent>, rusqlite::Error> {
    let conn = Connection::open_with_flags(
        arak_db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;

    let mut events: Vec<ArakEvent> = Vec::new();

    if let Ok(mut stmt) = conn.prepare(
        "SELECT block_number, gameId, player, capacity
         FROM created WHERE block_number > ?1 ORDER BY block_number, log_index",
    ) {
        let rows = stmt.query_map([cursor], |row| {
            Ok(ArakEvent::Created {
                block_number: row.get(0)?,
                game_id: row.get(1)?,
                player: row.get(2)?,
                capacity: row.get(3)?,
            })
        })?;
        for row in rows {
            events.push(row?);
        }
    }

    if let Ok(mut stmt) = conn.prepare(
        "SELECT j.block_number, j.gameId, j.player, j.players, c.capacity
         FROM joined j
         LEFT JOIN created c ON c.gameId = j.gameId
         WHERE j.block_number > ?1 ORDER BY j.block_number, j.log_index",
    ) {
        let rows = stmt.query_map([cursor], |row| {
            Ok(ArakEvent::Joined {
                block_number: row.get(0)?,
                game_id: row.get(1)?,
                player: row.get(2)?,
                players: row.get(3)?,
                capacity: row.get::<_, Option<i64>>(4)?.unwrap_or(0),
            })
        })?;
        for row in rows {
            events.push(row?);
        }
    }

    if let Ok(mut stmt) = conn.prepare(
        "SELECT block_number, gameId
         FROM resolved WHERE block_number > ?1 ORDER BY block_number, log_index",
    ) {
        let rows = stmt.query_map([cursor], |row| {
            Ok(ArakEvent::Resolved {
                block_number: row.get(0)?,
                game_id: row.get(1)?,
            })
        })?;
        for row in rows {
            events.push(row?);
        }
    }

    if let Ok(mut stmt) = conn.prepare(
        "SELECT block_number, player, gameId, won, guesses
         FROM game_recorded WHERE block_number > ?1 ORDER BY block_number, log_index",
    ) {
        let rows = stmt.query_map([cursor], |row| {
            Ok(ArakEvent::GameRecorded {
                block_number: row.get(0)?,
                player: row.get(1)?,
                game_id: row.get(2)?,
                won: row.get::<_, i32>(3)? != 0,
                guesses: row.get(4)?,
            })
        })?;
        for row in rows {
            events.push(row?);
        }
    }

    events.sort_by_key(|e| e.block_number());
    Ok(events)
}

async fn prepare_pvp_game<R: GameRepository>(
    repo: Arc<R>,
    game_id: &str,
    resolver: Option<Arc<ResolverClient>>,
) {
    let word_index = game::random_word_index();
    let salt = game::generate_salt();

    let game_id_bytes = {
        let stripped = game_id.trim_start_matches("0x");
        let mut buf = [0u8; 32];
        if let Ok(decoded) = hex::decode(stripped) {
            if decoded.len() == 32 {
                buf.copy_from_slice(&decoded);
            }
        }
        buf
    };

    let commitment = game::compute_pvp_commitment(&game_id_bytes, word_index, &salt);

    let record = GameRecord {
        id: game_id.to_string(),
        game_type: "pvp".into(),
        word_index,
        salt: Some(hex::encode(salt)),
        commitment: Some(hex::encode(commitment)),
        status: "active".into(),
        created_at: String::new(),
    };

    match repo.create_game(&record).await {
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
