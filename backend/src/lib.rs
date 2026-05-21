pub mod db;
pub mod game;
mod words;

use axum::{
    Router,
    extract::{Json, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
};
use db::{
    models::{GameRecord, GuessRecord},
    repository::{GameRepository, RepositoryError},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tracing::error;

struct AppState<R: GameRepository> {
    repo: R,
}

#[derive(Serialize)]
struct GameResponse {
    #[serde(rename = "gameId")]
    game_id: u32,
}

#[derive(Deserialize)]
struct GuessRequest {
    guess: String,
    #[serde(rename = "gameId")]
    game_id: u32,
    #[serde(rename = "guessNumber")]
    guess_number: u32,
    #[serde(default)]
    player: Option<String>,
}

#[derive(Serialize)]
struct GuessResponse {
    guess: String,
    results: Vec<game::LetterResult>,
    won: bool,
    #[serde(rename = "gameOver")]
    game_over: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    answer: Option<String>,
}

#[derive(Serialize)]
struct ErrorResponse {
    error: String,
}

async fn get_game<R: GameRepository>(State(state): State<Arc<AppState<R>>>) -> impl IntoResponse {
    let game_id = game::get_game_id();
    let game_id_str = game_id.to_string();

    match state.repo.get_game(&game_id_str).await {
        Ok(Some(_)) => {}
        Ok(None) => {
            let word_index = game::answer_index(game_id);
            let salt = game::generate_salt();
            let commitment = game::compute_commitment(game_id, word_index, &salt);
            let record = GameRecord {
                id: game_id_str.clone(),
                game_type: "daily".into(),
                word_index,
                salt: Some(hex::encode(salt)),
                commitment: Some(hex::encode(commitment)),
                status: "active".into(),
                created_at: String::new(),
            };
            match state.repo.create_game(&record).await {
                Ok(()) => {}
                Err(RepositoryError::Conflict(_)) => {}
                Err(e) => {
                    error!("Failed to create game {game_id_str}: {e}");
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(
                            serde_json::to_value(ErrorResponse {
                                error: "Failed to initialize game".into(),
                            })
                            .unwrap(),
                        ),
                    );
                }
            }
        }
        Err(e) => {
            error!("Failed to fetch game {game_id_str}: {e}");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(
                    serde_json::to_value(ErrorResponse {
                        error: "Failed to fetch game".into(),
                    })
                    .unwrap(),
                ),
            );
        }
    }

    (
        StatusCode::OK,
        Json(serde_json::to_value(GameResponse { game_id }).unwrap()),
    )
}

async fn post_guess<R: GameRepository>(
    State(state): State<Arc<AppState<R>>>,
    Json(req): Json<GuessRequest>,
) -> impl IntoResponse {
    let normalized = req.guess.to_lowercase();

    if normalized.len() != game::WORD_LENGTH || !normalized.bytes().all(|b| b.is_ascii_lowercase())
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                serde_json::to_value(ErrorResponse {
                    error: "Guess must be 5 letters".into(),
                })
                .unwrap(),
            ),
        );
    }

    if !game::is_valid_guess(&normalized) {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                serde_json::to_value(ErrorResponse {
                    error: "Not in word list".into(),
                })
                .unwrap(),
            ),
        );
    }

    if req.guess_number >= game::MAX_GUESSES as u32 {
        return (
            StatusCode::BAD_REQUEST,
            Json(
                serde_json::to_value(ErrorResponse {
                    error: "Invalid guess number".into(),
                })
                .unwrap(),
            ),
        );
    }

    let game_id_str = req.game_id.to_string();
    let answer = match state.repo.get_game(&game_id_str).await {
        Ok(Some(g)) => game::get_answer_by_index(g.word_index),
        _ => game::get_answer(req.game_id),
    };

    let results = game::evaluate_guess(&normalized, answer);
    let won = results.iter().all(|r| *r == game::LetterResult::Correct);
    let game_over = won || req.guess_number >= game::MAX_GUESSES as u32 - 1;

    if let Some(ref address) = req.player {
        if let Ok(player) = state.repo.get_or_create_player(address).await {
            let results_json = serde_json::to_string(&results).unwrap_or_default();
            let guess_record = GuessRecord {
                id: None,
                game_id: game_id_str.clone(),
                player_id: player.id,
                guess_number: req.guess_number,
                word: normalized.clone(),
                results: results_json,
                is_correct: won,
                created_at: None,
            };
            if let Err(e) = state.repo.record_guess(&guess_record).await {
                error!("Failed to record guess for game {game_id_str}: {e}");
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(
                        serde_json::to_value(ErrorResponse {
                            error: "Failed to record guess".into(),
                        })
                        .unwrap(),
                    ),
                );
            }
        }
    }

    let response = GuessResponse {
        guess: normalized,
        results: results.to_vec(),
        won,
        game_over,
        answer: if game_over {
            Some(answer.to_string())
        } else {
            None
        },
    };

    (
        StatusCode::OK,
        Json(serde_json::to_value(response).unwrap()),
    )
}

async fn health() -> &'static str {
    "ok"
}

pub fn build_router<R: GameRepository>(repo: R) -> Router {
    let state = Arc::new(AppState { repo });
    Router::new()
        .route("/health", get(health))
        .route("/api/game", get(get_game::<R>))
        .route("/api/guess", post(post_guess::<R>))
        .layer(CorsLayer::permissive())
        .with_state(state)
}
