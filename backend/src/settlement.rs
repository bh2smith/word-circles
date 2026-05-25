use crate::chain::ResolverClient;
use crate::db::models::{GamePlayerRecord, GameRecord};
use crate::db::repository::GameRepository;
use crate::game;
use crate::indexer::parse_game_id_bytes;
use alloy::primitives::{Address, U256};
use std::sync::Arc;
use std::time::Duration;

pub struct SettlementResult {
    pub winners: Vec<Address>,
    pub amounts: Vec<U256>,
}

pub fn determine_winner(players: &[GamePlayerRecord], game: &GameRecord) -> SettlementResult {
    let capacity = game.capacity.unwrap_or(2) as u64;
    let per_player: U256 = game
        .amount
        .as_deref()
        .and_then(|s| s.parse().ok())
        .unwrap_or(U256::ZERO);
    let pot = per_player * U256::from(capacity);

    if players.len() < 2 {
        return SettlementResult {
            winners: vec![],
            amounts: vec![],
        };
    }

    let p1 = &players[0];
    let p2 = &players[1];

    let p1_addr: Address = p1.address.parse().unwrap_or(Address::ZERO);
    let p2_addr: Address = p2.address.parse().unwrap_or(Address::ZERO);

    let p1_finished = p1.finished_at.is_some();
    let p2_finished = p2.finished_at.is_some();

    // Both timed out / neither finished
    if !p1_finished && !p2_finished {
        let half = pot / U256::from(2);
        return SettlementResult {
            winners: vec![p1_addr, p2_addr],
            amounts: vec![half, pot - half],
        };
    }

    // One finished, other didn't
    if p1_finished && !p2_finished {
        return SettlementResult {
            winners: vec![p1_addr],
            amounts: vec![pot],
        };
    }
    if !p1_finished && p2_finished {
        return SettlementResult {
            winners: vec![p2_addr],
            amounts: vec![pot],
        };
    }

    // Both finished — compare results
    match (p1.solved, p2.solved) {
        (true, false) => SettlementResult {
            winners: vec![p1_addr],
            amounts: vec![pot],
        },
        (false, true) => SettlementResult {
            winners: vec![p2_addr],
            amounts: vec![pot],
        },
        (true, true) => {
            if p1.guess_count < p2.guess_count {
                SettlementResult {
                    winners: vec![p1_addr],
                    amounts: vec![pot],
                }
            } else if p2.guess_count < p1.guess_count {
                SettlementResult {
                    winners: vec![p2_addr],
                    amounts: vec![pot],
                }
            } else {
                let half = pot / U256::from(2);
                SettlementResult {
                    winners: vec![p1_addr, p2_addr],
                    amounts: vec![half, pot - half],
                }
            }
        }
        (false, false) => {
            let half = pot / U256::from(2);
            SettlementResult {
                winners: vec![p1_addr, p2_addr],
                amounts: vec![half, pot - half],
            }
        }
    }
}

pub async fn settle_game<R: GameRepository>(
    repo: Arc<R>,
    resolver: Arc<ResolverClient>,
    game_id: &str,
) {
    let game = match repo.get_game(game_id).await {
        Ok(Some(g)) => g,
        Ok(None) => {
            tracing::error!(game_id, "Settlement: game not found");
            return;
        }
        Err(e) => {
            tracing::error!(game_id, "Settlement: failed to fetch game: {e}");
            return;
        }
    };

    if game.status != "active" {
        tracing::debug!(game_id, status = %game.status, "Settlement: game not active, skipping");
        return;
    }

    let players = match repo.get_game_players(game_id).await {
        Ok(p) => p,
        Err(e) => {
            tracing::error!(game_id, "Settlement: failed to fetch players: {e}");
            return;
        }
    };

    let result = determine_winner(&players, &game);
    let game_id_bytes = parse_game_id_bytes(game_id);

    let signature = match resolver
        .sign_resolution(game_id_bytes, &result.winners, &result.amounts)
        .await
    {
        Ok(sig) => sig,
        Err(e) => {
            tracing::error!(game_id, "Settlement: failed to sign: {e}");
            return;
        }
    };

    match resolver
        .resolve_escrow(
            game_id_bytes,
            result.winners.clone(),
            result.amounts.clone(),
            signature,
        )
        .await
    {
        Ok(tx_hash) => {
            tracing::info!(game_id, %tx_hash, "Settlement: resolve tx submitted");
        }
        Err(e) => {
            tracing::error!(game_id, "Settlement: resolve tx failed: {e}");
            return;
        }
    }

    if let (Some(salt_hex), word_index) = (&game.salt, game.word_index) {
        if let Ok(salt_bytes) = hex::decode(salt_hex) {
            if salt_bytes.len() == 32 {
                let mut salt = [0u8; 32];
                salt.copy_from_slice(&salt_bytes);
                match resolver.reveal(game_id_bytes, word_index, salt).await {
                    Ok(tx_hash) => {
                        tracing::info!(game_id, %tx_hash, "Settlement: reveal tx submitted");
                    }
                    Err(e) => {
                        tracing::warn!(game_id, "Settlement: reveal tx failed: {e}");
                    }
                }
            }
        }
    }

    if let Err(e) = repo.update_game_status(game_id, "settled").await {
        tracing::error!(game_id, "Settlement: failed to update status: {e}");
    }

    let answer = game::get_answer_by_index(game.word_index);
    tracing::info!(
        game_id,
        answer,
        winners = ?result.winners,
        "Settlement complete"
    );
}

pub async fn run_timeout_loop<R: GameRepository>(
    repo: Arc<R>,
    resolver: Arc<ResolverClient>,
    poll_interval: Duration,
    default_timeout_secs: u32,
) {
    tracing::info!("PvP timeout loop started");

    loop {
        tokio::time::sleep(poll_interval).await;

        let games = match repo.get_active_pvp_games().await {
            Ok(g) => g,
            Err(e) => {
                tracing::warn!("Timeout loop: failed to query games: {e}");
                continue;
            }
        };

        let now = chrono::Utc::now().naive_utc();

        for game in games {
            let timeout = game.timeout_secs.unwrap_or(default_timeout_secs);
            let players = match repo.get_game_players(&game.id).await {
                Ok(p) => p,
                Err(_) => continue,
            };

            for player in &players {
                if player.finished_at.is_some() {
                    continue;
                }

                let expired = if let Some(ref started) = player.started_at {
                    is_expired(started, timeout, &now)
                } else {
                    is_expired(&game.created_at, timeout, &now)
                };

                if expired {
                    tracing::info!(
                        game_id = %game.id,
                        player = %player.address,
                        "Timeout: forcing player finish"
                    );
                    let _ = repo
                        .update_game_player_finished(
                            &game.id,
                            player.player_id,
                            false,
                            player.guess_count,
                        )
                        .await;
                }
            }

            let updated_players = match repo.get_game_players(&game.id).await {
                Ok(p) => p,
                Err(_) => continue,
            };

            let all_done = updated_players.iter().all(|p| p.finished_at.is_some());
            if all_done {
                let repo = Arc::clone(&repo);
                let resolver = Arc::clone(&resolver);
                let game_id = game.id.clone();
                tokio::spawn(async move {
                    settle_game(repo, resolver, &game_id).await;
                });
            }
        }
    }
}

fn is_expired(timestamp: &str, timeout_secs: u32, now: &chrono::NaiveDateTime) -> bool {
    let Ok(ts) = chrono::NaiveDateTime::parse_from_str(timestamp, "%Y-%m-%dT%H:%M:%SZ") else {
        return false;
    };
    let elapsed = now.signed_duration_since(ts);
    elapsed.num_seconds() > timeout_secs as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::address;

    fn player(addr: &str, solved: bool, guesses: u32, finished: bool) -> GamePlayerRecord {
        GamePlayerRecord {
            game_id: "test".into(),
            player_id: 0,
            address: addr.into(),
            started_at: Some("2026-01-01T00:00:00Z".into()),
            finished_at: if finished {
                Some("2026-01-01T01:00:00Z".into())
            } else {
                None
            },
            solved,
            guess_count: guesses,
        }
    }

    fn game_with_pot(amount: &str, capacity: u32) -> GameRecord {
        GameRecord {
            id: "test".into(),
            game_type: "pvp".into(),
            word_index: 0,
            salt: None,
            commitment: None,
            status: "active".into(),
            created_at: String::new(),
            capacity: Some(capacity),
            token: Some("0xtoken".into()),
            amount: Some(amount.into()),
            timeout_secs: Some(10800),
        }
    }

    #[test]
    fn solver_beats_non_solver() {
        let players = vec![
            player("0x0000000000000000000000000000000000000001", true, 4, true),
            player("0x0000000000000000000000000000000000000002", false, 6, true),
        ];
        let game = game_with_pot("10", 2);
        let result = determine_winner(&players, &game);

        assert_eq!(result.winners.len(), 1);
        assert_eq!(
            result.winners[0],
            address!("0x0000000000000000000000000000000000000001")
        );
        assert_eq!(result.amounts[0], U256::from(20));
    }

    #[test]
    fn fewer_guesses_wins() {
        let players = vec![
            player("0x0000000000000000000000000000000000000001", true, 3, true),
            player("0x0000000000000000000000000000000000000002", true, 5, true),
        ];
        let game = game_with_pot("10", 2);
        let result = determine_winner(&players, &game);

        assert_eq!(result.winners.len(), 1);
        assert_eq!(
            result.winners[0],
            address!("0x0000000000000000000000000000000000000001")
        );
        assert_eq!(result.amounts[0], U256::from(20));
    }

    #[test]
    fn same_guesses_splits() {
        let players = vec![
            player("0x0000000000000000000000000000000000000001", true, 4, true),
            player("0x0000000000000000000000000000000000000002", true, 4, true),
        ];
        let game = game_with_pot("10", 2);
        let result = determine_winner(&players, &game);

        assert_eq!(result.winners.len(), 2);
        assert_eq!(result.amounts[0], U256::from(10));
        assert_eq!(result.amounts[1], U256::from(10));
    }

    #[test]
    fn neither_solved_splits() {
        let players = vec![
            player("0x0000000000000000000000000000000000000001", false, 6, true),
            player("0x0000000000000000000000000000000000000002", false, 6, true),
        ];
        let game = game_with_pot("10", 2);
        let result = determine_winner(&players, &game);

        assert_eq!(result.winners.len(), 2);
        assert_eq!(result.amounts[0] + result.amounts[1], U256::from(20));
    }

    #[test]
    fn finisher_beats_timeout() {
        let players = vec![
            player("0x0000000000000000000000000000000000000001", false, 6, true),
            player(
                "0x0000000000000000000000000000000000000002",
                false,
                2,
                false,
            ),
        ];
        let game = game_with_pot("10", 2);
        let result = determine_winner(&players, &game);

        assert_eq!(result.winners.len(), 1);
        assert_eq!(
            result.winners[0],
            address!("0x0000000000000000000000000000000000000001")
        );
        assert_eq!(result.amounts[0], U256::from(20));
    }

    #[test]
    fn both_timeout_splits() {
        let players = vec![
            player(
                "0x0000000000000000000000000000000000000001",
                false,
                0,
                false,
            ),
            player(
                "0x0000000000000000000000000000000000000002",
                false,
                0,
                false,
            ),
        ];
        let game = game_with_pot("10", 2);
        let result = determine_winner(&players, &game);

        assert_eq!(result.winners.len(), 2);
        assert_eq!(result.amounts[0] + result.amounts[1], U256::from(20));
    }

    #[test]
    fn large_amounts_work() {
        let players = vec![
            player("0x0000000000000000000000000000000000000001", true, 3, true),
            player("0x0000000000000000000000000000000000000002", false, 6, true),
        ];
        let game = game_with_pot("10000000000000000000", 2); // 10e18
        let result = determine_winner(&players, &game);

        assert_eq!(result.winners.len(), 1);
        assert_eq!(
            result.amounts[0],
            U256::from(20_000_000_000_000_000_000u128)
        );
    }
}
