use crate::db::repository::GameRepository;
use rusqlite::Connection;
use std::sync::Arc;
use std::time::Duration;

pub struct IndexerConfig {
    pub arak_db_path: String,
    pub poll_interval: Duration,
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
                    ..
                } => {
                    tracing::info!(game_id, block_number, player, players, "Joined");
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
        players: String,
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
        "SELECT block_number, gameId, player, players
         FROM joined WHERE block_number > ?1 ORDER BY block_number, log_index",
    ) {
        let rows = stmt.query_map([cursor], |row| {
            Ok(ArakEvent::Joined {
                block_number: row.get(0)?,
                game_id: row.get(1)?,
                player: row.get(2)?,
                players: row.get(3)?,
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
