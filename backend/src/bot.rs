//! PvP matchmaking bot.
//!
//! Fills lonely lobbies so a solo player can always find a match: it watches
//! for `waiting` PvP games that have sat past a join delay and joins the same
//! escrow lobby (approving the escrow for the stake token once, then `join`),
//! then plays the game to completion through the normal game state. The bot runs
//! in-process alongside the indexer and settlement loop, behind `BOT_ENABLED`.
//!
//! Approve and join are sent as separate single-call Safe transactions, never a
//! MultiSend batch — see `approve_and_join` for why (a safe-rs 0.9.0 batch
//! gas-estimation bug). Granting the escrow an allowance out-of-band (e.g. a
//! one-time max approval from the Safe) means the steady-state join is a single
//! `join` call.
//!
//! The bot plays as a Circles account (a Safe) controlled by an owner EOA, so
//! it appears on-chain as a real Circles avatar — exactly like a human playing
//! via the miniapp. Funding: the Safe (`BOT_SAFE_ADDRESS`) must hold enough of
//! the staking Circles token to cover `PVP_AMOUNT` per game it joins.

use crate::db::models::GuessRecord;
use crate::db::repository::GameRepository;
use crate::game;
use crate::words::ANSWERS;
use alloy::{
    primitives::{Address, U256},
    sol,
    sol_types::SolCall,
};
use circles_sdk::{ContractRunner, SafeContractRunner, SubmittedTx, call_to_tx};
use rand::Rng;
use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

sol! {
    interface IERC20 {
        function approve(address spender, uint256 value) external returns (bool);
        function allowance(address owner, address spender) external view returns (uint256);
    }

    interface IEscrow {
        function join(address resolver, address token, uint256 amount, uint128 capacity)
            external returns (bytes32);
    }
}

// A common opener — narrows the candidate set quickly without making the bot
// unbeatable.
const OPENER: &str = "crane";

pub struct BotConfig {
    pub poll_interval: Duration,
    /// How long a lobby must sit `waiting` before the bot fills it, giving
    /// human opponents first chance at the match.
    pub join_delay: Duration,
}

pub struct BotClient {
    // circles-sdk Safe runner: approve+join submit as the Circles account (the
    // Safe), signed by the owner EOA, so the escrow `msg.sender` is the bot's
    // Circles avatar — exactly like a human playing via the miniapp.
    runner: SafeContractRunner,
    escrow: Address,
    resolver: Address,
    token: Address,
    amount: U256,
    capacity: u128,
}

impl BotClient {
    /// Builds the bot from env. `resolver` is the resolver address the lobby is
    /// keyed on (so the bot joins the same lobby humans do). The bot plays as
    /// the Circles account (Safe) at `BOT_SAFE_ADDRESS`, signed by the
    /// `BOT_PRIVATE_KEY` owner.
    pub async fn from_env(resolver: Address) -> Result<Self, String> {
        let key_hex =
            std::env::var("BOT_PRIVATE_KEY").map_err(|_| "BOT_PRIVATE_KEY not set".to_string())?;
        let rpc_url = std::env::var("RPC_URL").map_err(|_| "RPC_URL not set".to_string())?;
        let escrow: Address = parse_env("ESCROW_ADDRESS")?;
        let token: Address = parse_env("PVP_TOKEN")?;
        let amount: U256 = parse_env("PVP_AMOUNT")?;
        let capacity: u128 = std::env::var("PVP_CAPACITY")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(2);
        let safe: Address = parse_env("BOT_SAFE_ADDRESS")?;

        let runner = SafeContractRunner::connect(&rpc_url, &key_hex, safe)
            .await
            .map_err(|e| format!("Safe runner: {e}"))?;

        Ok(Self {
            runner,
            escrow,
            resolver,
            token,
            amount,
            capacity,
        })
    }

    /// The Circles account (Safe) address — the escrow `msg.sender`.
    pub fn address(&self) -> Address {
        self.runner.sender_address()
    }

    /// Current ERC20 allowance the bot Safe has granted the escrow for the stake
    /// token, read via the runner's provider.
    async fn escrow_allowance(&self) -> Result<U256, String> {
        let tx = call_to_tx(
            self.token,
            IERC20::allowanceCall {
                owner: self.address(),
                spender: self.escrow,
            },
            None,
        );
        let bytes = self.runner.call(tx).await.map_err(|e| e.to_string())?;
        let allowance = IERC20::allowanceCall::abi_decode_returns(&bytes)
            .map_err(|e| format!("decode allowance: {e}"))?;
        Ok(allowance)
    }

    /// Joins the waiting lobby, approving the escrow for the stake first only when
    /// the standing allowance is insufficient. The escrow pairs the bot into the
    /// game via its lobby counter.
    ///
    /// Approve and join are sent as SEPARATE single-call Safe transactions rather
    /// than one MultiSend batch: safe-rs 0.9.0's batch path estimates gas as a
    /// plain CALL into MultiSend (dropping the required DELEGATECALL), which the
    /// MultiSend guard reverts ("MultiSend should only be called via
    /// delegatecall"). Single-call submissions use Operation::Call and avoid that
    /// path entirely. In steady state the allowance is already set, so the bot
    /// only sends `join` and never touches the batch path at all.
    async fn approve_and_join(&self) -> Result<Vec<SubmittedTx>, String> {
        let mut submitted = Vec::new();

        if self.escrow_allowance().await? < self.amount {
            // Approve once with the max so future joins skip this branch (and the
            // MultiSend path). Sent on its own — not batched with join.
            let approve = call_to_tx(
                self.token,
                IERC20::approveCall {
                    spender: self.escrow,
                    value: U256::MAX,
                },
                None,
            );
            submitted.extend(
                self.runner
                    .send_transactions(vec![approve])
                    .await
                    .map_err(|e| e.to_string())?,
            );
        }

        let join = call_to_tx(
            self.escrow,
            IEscrow::joinCall {
                resolver: self.resolver,
                token: self.token,
                amount: self.amount,
                capacity: self.capacity,
            },
            None,
        );
        submitted.extend(
            self.runner
                .send_transactions(vec![join])
                .await
                .map_err(|e| e.to_string())?,
        );
        Ok(submitted)
    }
}

fn parse_env<T: std::str::FromStr>(key: &str) -> Result<T, String> {
    std::env::var(key)
        .ok()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("{key} not set/invalid"))
}

pub async fn run<R: GameRepository>(repo: Arc<R>, client: BotClient, config: BotConfig) {
    let bot_addr = format!("0x{:x}", client.address());
    tracing::info!(bot = %bot_addr, "PvP bot started");

    // Lobbies we've already submitted a join for, so we don't double-join while
    // the indexer catches up to our on-chain join.
    let mut attempted: HashSet<String> = HashSet::new();

    loop {
        fill_waiting_lobbies(&*repo, &client, &bot_addr, &config, &mut attempted).await;
        play_active_games(&*repo, &bot_addr).await;
        tokio::time::sleep(config.poll_interval).await;
    }
}

async fn fill_waiting_lobbies<R: GameRepository>(
    repo: &R,
    client: &BotClient,
    bot_addr: &str,
    config: &BotConfig,
    attempted: &mut HashSet<String>,
) {
    let waiting = match repo.get_pvp_games_by_status("waiting").await {
        Ok(g) => g,
        Err(e) => {
            tracing::warn!("bot: failed to list waiting games: {e}");
            return;
        }
    };

    for g in waiting {
        if attempted.contains(&g.id) {
            continue;
        }
        if !older_than(&g.created_at, config.join_delay) {
            continue;
        }
        let players = repo.get_game_players(&g.id).await.unwrap_or_default();
        let capacity = g.capacity.unwrap_or(2) as usize;
        if players.len() >= capacity {
            continue;
        }
        if players
            .iter()
            .any(|p| p.address.eq_ignore_ascii_case(bot_addr))
        {
            continue;
        }

        // Mark before sending so a slow/failed tx doesn't trigger repeated joins.
        attempted.insert(g.id.clone());
        match client.approve_and_join().await {
            Ok(txs) => {
                let ok = txs.iter().all(|t| t.success);
                tracing::info!(game = %g.id, txs = txs.len(), ok, "bot joined lobby");
            }
            Err(e) => {
                tracing::warn!(game = %g.id, "bot join failed: {e}");
                attempted.remove(&g.id);
            }
        }
    }
}

async fn play_active_games<R: GameRepository>(repo: &R, bot_addr: &str) {
    let active = match repo.get_pvp_games_by_status("active").await {
        Ok(g) => g,
        Err(e) => {
            tracing::warn!("bot: failed to list active games: {e}");
            return;
        }
    };

    for g in active {
        let players = repo.get_game_players(&g.id).await.unwrap_or_default();
        let Some(me) = players
            .iter()
            .find(|p| p.address.eq_ignore_ascii_case(bot_addr))
        else {
            continue;
        };
        if me.finished_at.is_some() {
            continue;
        }
        play_game(repo, &g, me.player_id).await;
    }
}

/// Plays a game to completion using only guess feedback (the bot recomputes
/// feedback in-process). Records each guess and finishes the player so the
/// settlement loop can resolve the pot. Reconstructs candidate state from any
/// already-recorded guesses so a mid-game restart resumes correctly.
async fn play_game<R: GameRepository>(
    repo: &R,
    game: &crate::db::models::GameRecord,
    player_id: i64,
) {
    let answer = game::get_answer_by_index(game.word_index);

    let existing = repo
        .get_guesses(&game.id, player_id)
        .await
        .unwrap_or_default();

    let mut candidates: Vec<&'static str> = ANSWERS.to_vec();
    for prior in &existing {
        let r = game::evaluate_guess(&prior.word, answer);
        candidates.retain(|c| game::evaluate_guess(&prior.word, c) == r);
    }

    let _ = repo.update_game_player_started(&game.id, player_id).await;

    let mut guess_num = existing.len();
    while guess_num < game::MAX_GUESSES {
        let word: &str = if guess_num == 0 {
            OPENER
        } else if candidates.is_empty() {
            answer // safety: the answer always remains a candidate
        } else {
            candidates[rand::rng().random_range(0..candidates.len())]
        };

        let results = game::evaluate_guess(word, answer);
        let won = results.iter().all(|r| *r == game::LetterResult::Correct);
        let results_json = serde_json::to_string(&results).unwrap_or_default();

        let record = GuessRecord {
            id: None,
            game_id: game.id.clone(),
            player_id,
            guess_number: guess_num as u32,
            word: word.to_string(),
            results: results_json,
            is_correct: won,
            created_at: None,
        };
        if let Err(e) = repo.record_guess(&record).await {
            tracing::warn!(game = %game.id, "bot record_guess failed: {e}");
            return;
        }

        let last = guess_num + 1 >= game::MAX_GUESSES;
        if won || last {
            let _ = repo
                .update_game_player_finished(&game.id, player_id, won, (guess_num + 1) as u32)
                .await;
            tracing::info!(game = %game.id, won, guesses = guess_num + 1, "bot finished game");
            return;
        }

        candidates.retain(|c| game::evaluate_guess(word, c) == results);
        guess_num += 1;
    }
}

fn older_than(created_at: &str, delay: Duration) -> bool {
    let Some(created) = crate::parse_timestamp(created_at) else {
        // Unparseable timestamps shouldn't block matchmaking.
        return true;
    };
    let elapsed = chrono::Utc::now()
        .naive_utc()
        .signed_duration_since(created);
    elapsed.num_seconds() >= delay.as_secs() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bot_solves_within_six_guesses() {
        // The strategy must always solve (the answer stays in the candidate set).
        for answer in ANSWERS.iter().take(50) {
            let mut candidates: Vec<&'static str> = ANSWERS.to_vec();
            let mut solved = false;
            for n in 0..game::MAX_GUESSES {
                let word = if n == 0 { OPENER } else { candidates[0] };
                let results = game::evaluate_guess(word, answer);
                if results.iter().all(|r| *r == game::LetterResult::Correct) {
                    solved = true;
                    break;
                }
                candidates.retain(|c| game::evaluate_guess(word, c) == results);
            }
            assert!(solved, "bot failed to solve {answer}");
        }
    }

    // Guards the allowance read in approve_and_join: the runner returns raw return
    // bytes, and we rely on abi_decode_returns yielding the U256 value so the
    // `allowance < amount` branch (which decides whether to skip the approve, and
    // thus the broken MultiSend path) is correct.
    #[test]
    fn allowance_return_decodes_to_u256() {
        let value = U256::from(1_000_000_000_000_000_000u128);
        let encoded = IERC20::allowanceCall::abi_encode_returns(&value);
        let decoded = IERC20::allowanceCall::abi_decode_returns(&encoded).unwrap();
        assert_eq!(decoded, value);
    }

    // Manual, real-broadcast smoke test for the bot's Safe send path. Builds the
    // BotClient from env and actually submits approve_and_join, so it exercises
    // the exact signing/broadcast that the circles-sdk fixes addressed
    // (eth_sendRawTransaction with populated nonce/gas/fees).
    //
    // #[ignore] so CI never runs it. Run against an ANVIL FORK of Gnosis to avoid
    // real funds / filling a live lobby:
    //   anvil --fork-url https://rpc.gnosischain.com --port 8545
    //   RPC_URL=http://localhost:8545 \
    //   BOT_PRIVATE_KEY=0x... BOT_SAFE_ADDRESS=0x335D5a9adA218A2b334c5E17242D15158e7380f9 \
    //   ESCROW_ADDRESS=0x20a44c2C546FEBb4dcE773868B532D14663467A0 \
    //   PVP_TOKEN=0xeeF7B1f06B092625228C835Dd5D5B14641D1e54A \
    //   PVP_AMOUNT=1000000000000000000 PVP_CAPACITY=2 \
    //   RESOLVER_ADDRESS=0x8ba11AdD9bB5B60028eff90A14f0AE20b429ce8F \
    //   cargo test -p word-circles-backend bot_join_once -- --ignored --nocapture
    //
    // Pointing RPC_URL at real Gnosis instead makes a real on-chain join (stakes
    // PVP_AMOUNT into the matching lobby) — do that only intentionally.
    #[tokio::test]
    #[ignore = "real-broadcast smoke test; run manually against an anvil fork"]
    async fn bot_join_once() {
        let resolver: Address = std::env::var("RESOLVER_ADDRESS")
            .expect("set RESOLVER_ADDRESS")
            .parse()
            .expect("RESOLVER_ADDRESS must be a valid 0x address");

        let client = BotClient::from_env(resolver)
            .await
            .expect("BotClient::from_env failed (check BOT_*/ESCROW/PVP_* env)");
        eprintln!("bot Safe: 0x{:x}", client.address());

        let txs = client
            .approve_and_join()
            .await
            .expect("approve_and_join failed");

        for (i, tx) in txs.iter().enumerate() {
            eprintln!(
                "tx[{i}] hash=0x{} success={}",
                hex::encode(&tx.tx_hash),
                tx.success
            );
        }
        assert!(!txs.is_empty(), "no transactions were submitted");
        assert!(
            txs.iter().all(|t| t.success),
            "a submitted transaction reverted"
        );
    }
}
