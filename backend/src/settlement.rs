use crate::chain::ResolverClient;
use crate::db::models::{GamePlayerRecord, GameRecord, GuessRecord};
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

/// Cumulative tile counts across all of a player's guesses, used to break a tie
/// when both players spent the same number of guesses. Greens (Correct) are the
/// primary tiebreaker, oranges (Present) the secondary.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TileScore {
    pub greens: u32,
    pub oranges: u32,
}

/// Sum greens/oranges over a player's recorded guesses. The winning guess (all
/// green) and any earlier rows all contribute, so a player who converged faster
/// — more greens/oranges along the way — outscores one who guessed wildly. Since
/// the tiebreak only fires on an equal guess count, both players have the same
/// number of rows, making this a fair comparison.
pub fn tally_tiles(guesses: &[GuessRecord]) -> TileScore {
    let mut score = TileScore::default();
    for g in guesses {
        let Ok(results) = serde_json::from_str::<Vec<game::LetterResult>>(&g.results) else {
            continue;
        };
        for r in results {
            match r {
                game::LetterResult::Correct => score.greens += 1,
                game::LetterResult::Present => score.oranges += 1,
                game::LetterResult::Absent => {}
            }
        }
    }
    score
}

/// Award the pot on the tile tiebreaker: most greens wins, then most oranges; a
/// genuine all-equal tie still splits.
fn break_tie(
    p1_addr: Address,
    p2_addr: Address,
    t1: TileScore,
    t2: TileScore,
    pot: U256,
) -> SettlementResult {
    let k1 = (t1.greens, t1.oranges);
    let k2 = (t2.greens, t2.oranges);
    if k1 > k2 {
        SettlementResult {
            winners: vec![p1_addr],
            amounts: vec![pot],
        }
    } else if k2 > k1 {
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

/// `tiles` is parallel to `players` (cumulative tile score per player) and is
/// only consulted to break an equal-guess-count tie.
pub fn determine_winner(
    players: &[GamePlayerRecord],
    tiles: &[TileScore],
    game: &GameRecord,
) -> SettlementResult {
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

    let t1 = tiles.first().copied().unwrap_or_default();
    let t2 = tiles.get(1).copied().unwrap_or_default();

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
                // Same guess count: break the tie on cumulative tiles.
                break_tie(p1_addr, p2_addr, t1, t2, pot)
            }
        }
        // Both finished without solving (each used all guesses): closest board
        // by cumulative tiles takes the pot.
        (false, false) => break_tie(p1_addr, p2_addr, t1, t2, pot),
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

    // Cumulative tile score per player, parallel to `players`, for the
    // equal-guess-count tiebreaker.
    let mut tiles = Vec::with_capacity(players.len());
    for p in &players {
        let guesses = repo
            .get_guesses(game_id, p.player_id)
            .await
            .unwrap_or_default();
        tiles.push(tally_tiles(&guesses));
    }

    let result = determine_winner(&players, &tiles, &game);
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

    fn tiles(g: u32, o: u32) -> TileScore {
        TileScore {
            greens: g,
            oranges: o,
        }
    }

    // Tile scores for cases decided before the tiebreaker (values irrelevant).
    const NO_TILES: [TileScore; 2] = [
        TileScore {
            greens: 0,
            oranges: 0,
        },
        TileScore {
            greens: 0,
            oranges: 0,
        },
    ];

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
        let result = determine_winner(&players, &NO_TILES, &game);

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
        let result = determine_winner(&players, &NO_TILES, &game);

        assert_eq!(result.winners.len(), 1);
        assert_eq!(
            result.winners[0],
            address!("0x0000000000000000000000000000000000000001")
        );
        assert_eq!(result.amounts[0], U256::from(20));
    }

    #[test]
    fn same_guesses_more_greens_wins() {
        // Both solved in 4; p1 accumulated more greens along the way.
        let players = vec![
            player("0x0000000000000000000000000000000000000001", true, 4, true),
            player("0x0000000000000000000000000000000000000002", true, 4, true),
        ];
        let game = game_with_pot("10", 2);
        let result = determine_winner(&players, &[tiles(11, 3), tiles(8, 5)], &game);

        assert_eq!(result.winners.len(), 1);
        assert_eq!(
            result.winners[0],
            address!("0x0000000000000000000000000000000000000001")
        );
        assert_eq!(result.amounts[0], U256::from(20));
    }

    #[test]
    fn same_guesses_equal_greens_more_oranges_wins() {
        // Equal greens — oranges break the tie in p2's favour.
        let players = vec![
            player("0x0000000000000000000000000000000000000001", true, 4, true),
            player("0x0000000000000000000000000000000000000002", true, 4, true),
        ];
        let game = game_with_pot("10", 2);
        let result = determine_winner(&players, &[tiles(9, 2), tiles(9, 6)], &game);

        assert_eq!(result.winners.len(), 1);
        assert_eq!(
            result.winners[0],
            address!("0x0000000000000000000000000000000000000002")
        );
        assert_eq!(result.amounts[0], U256::from(20));
    }

    #[test]
    fn same_guesses_equal_tiles_splits() {
        // Genuinely identical boards still split.
        let players = vec![
            player("0x0000000000000000000000000000000000000001", true, 4, true),
            player("0x0000000000000000000000000000000000000002", true, 4, true),
        ];
        let game = game_with_pot("10", 2);
        let result = determine_winner(&players, &[tiles(9, 4), tiles(9, 4)], &game);

        assert_eq!(result.winners.len(), 2);
        assert_eq!(result.amounts[0], U256::from(10));
        assert_eq!(result.amounts[1], U256::from(10));
    }

    #[test]
    fn neither_solved_closest_board_wins() {
        // Both failed (used all guesses); the closer board takes the pot.
        let players = vec![
            player("0x0000000000000000000000000000000000000001", false, 6, true),
            player("0x0000000000000000000000000000000000000002", false, 6, true),
        ];
        let game = game_with_pot("10", 2);
        let result = determine_winner(&players, &[tiles(7, 4), tiles(10, 2)], &game);

        assert_eq!(result.winners.len(), 1);
        assert_eq!(
            result.winners[0],
            address!("0x0000000000000000000000000000000000000002")
        );
        assert_eq!(result.amounts[0], U256::from(20));
    }

    #[test]
    fn neither_solved_equal_tiles_splits() {
        let players = vec![
            player("0x0000000000000000000000000000000000000001", false, 6, true),
            player("0x0000000000000000000000000000000000000002", false, 6, true),
        ];
        let game = game_with_pot("10", 2);
        let result = determine_winner(&players, &[tiles(5, 3), tiles(5, 3)], &game);

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
        let result = determine_winner(&players, &NO_TILES, &game);

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
        let result = determine_winner(&players, &NO_TILES, &game);

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
        let result = determine_winner(&players, &NO_TILES, &game);

        assert_eq!(result.winners.len(), 1);
        assert_eq!(
            result.amounts[0],
            U256::from(20_000_000_000_000_000_000u128)
        );
    }

    #[test]
    fn tally_tiles_counts_greens_and_oranges() {
        let guess = |results: &str| GuessRecord {
            id: None,
            game_id: "g".into(),
            player_id: 0,
            guess_number: 0,
            word: "crane".into(),
            results: results.into(),
            is_correct: false,
            created_at: None,
        };
        let guesses = vec![
            guess(r#"["correct","absent","present","absent","present"]"#),
            guess(r#"["correct","correct","correct","correct","correct"]"#),
        ];
        assert_eq!(tally_tiles(&guesses), tiles(6, 2));
    }
}
