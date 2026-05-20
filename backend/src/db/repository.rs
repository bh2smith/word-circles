use super::models::{GameRecord, GuessRecord, PlayerRecord};
use std::fmt;
use std::future::Future;

#[derive(Debug)]
pub enum RepositoryError {
    NotFound,
    Conflict(String),
    Internal(String),
}

impl fmt::Display for RepositoryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound => write!(f, "not found"),
            Self::Conflict(msg) => write!(f, "conflict: {msg}"),
            Self::Internal(msg) => write!(f, "internal error: {msg}"),
        }
    }
}

impl std::error::Error for RepositoryError {}

pub trait GameRepository: Send + Sync + 'static {
    fn create_game(
        &self,
        game: &GameRecord,
    ) -> impl Future<Output = Result<(), RepositoryError>> + Send;

    fn get_game(
        &self,
        game_id: &str,
    ) -> impl Future<Output = Result<Option<GameRecord>, RepositoryError>> + Send;

    fn update_game_status(
        &self,
        game_id: &str,
        status: &str,
    ) -> impl Future<Output = Result<(), RepositoryError>> + Send;

    fn get_or_create_player(
        &self,
        address: &str,
    ) -> impl Future<Output = Result<PlayerRecord, RepositoryError>> + Send;

    fn record_guess(
        &self,
        guess: &GuessRecord,
    ) -> impl Future<Output = Result<(), RepositoryError>> + Send;

    fn get_guesses(
        &self,
        game_id: &str,
        player_id: i64,
    ) -> impl Future<Output = Result<Vec<GuessRecord>, RepositoryError>> + Send;

    fn get_guess_count(
        &self,
        game_id: &str,
        player_id: i64,
    ) -> impl Future<Output = Result<u32, RepositoryError>> + Send;
}
