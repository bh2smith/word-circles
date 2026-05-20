mod game;
mod words;

use axum::{
    Router,
    extract::Json,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
};
use serde::{Deserialize, Serialize};
use tower_http::cors::CorsLayer;

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

async fn get_game() -> Json<GameResponse> {
    Json(GameResponse {
        game_id: game::get_game_id(),
    })
}

async fn post_guess(Json(req): Json<GuessRequest>) -> impl IntoResponse {
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

    let answer = game::get_answer(req.game_id);
    let results = game::evaluate_guess(&normalized, answer);
    let won = results.iter().all(|r| *r == game::LetterResult::Correct);
    let game_over = won || req.guess_number >= game::MAX_GUESSES as u32 - 1;

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
    let addr = format!("0.0.0.0:{port}");

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/game", get(get_game))
        .route("/api/guess", post(post_guess))
        .layer(CorsLayer::permissive());

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    println!("Backend listening on {addr}");
    axum::serve(listener, app).await.unwrap();
}
