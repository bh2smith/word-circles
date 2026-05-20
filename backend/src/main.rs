mod db;
mod game;
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
    repository::GameRepository,
    sqlite::SqliteRepository,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tower_http::cors::CorsLayer;

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

async fn get_game<R: GameRepository>(State(state): State<Arc<AppState<R>>>) -> Json<GameResponse> {
    let game_id = game::get_game_id();
    let game_id_str = game_id.to_string();

    if state
        .repo
        .get_game(&game_id_str)
        .await
        .ok()
        .flatten()
        .is_none()
    {
        let word_index = game::answer_index(game_id);
        let record = GameRecord {
            id: game_id_str,
            game_type: "daily".into(),
            word_index,
            salt: None,
            commitment: None,
            status: "active".into(),
            created_at: String::new(),
        };
        let _ = state.repo.create_game(&record).await;
    }

    Json(GameResponse { game_id })
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
            let _ = state.repo.record_guess(&guess_record).await;
        }

        if game_over {
            let _ = state
                .repo
                .update_game_status(&game_id_str, "completed")
                .await;
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

#[tokio::main]
async fn main() {
    let port = std::env::var("PORT").unwrap_or_else(|_| "3001".into());
    let db_path = std::env::var("DATABASE_PATH").unwrap_or_else(|_| "word-circles.db".into());
    let addr = format!("0.0.0.0:{port}");

    let repo = SqliteRepository::new(&db_path).expect("Failed to initialize database");
    let state = Arc::new(AppState { repo });

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/game", get(get_game::<SqliteRepository>))
        .route("/api/guess", post(post_guess::<SqliteRepository>))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    println!("Backend listening on {addr}");
    axum::serve(listener, app).await.unwrap();
}
