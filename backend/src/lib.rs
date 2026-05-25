pub mod chain;
pub mod db;
pub mod game;
pub mod indexer;
mod words;

use axum::{
    Router,
    extract::{Json, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
};
use chain::ContractConfig;
use db::{
    models::{DailyResult, GameRecord, GuessRecord, LeaderboardEntry},
    repository::{GameRepository, RepositoryError},
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tower_http::cors::CorsLayer;
use tracing::{debug, error};
use utoipa::{IntoParams, OpenApi, ToSchema};
use utoipa_swagger_ui::SwaggerUi;

struct AppState<R: GameRepository> {
    repo: R,
    contract_config: Option<ContractConfig>,
}

#[derive(Serialize, ToSchema)]
struct GameResponse {
    #[serde(rename = "gameId")]
    game_id: u32,
}

#[derive(Deserialize, ToSchema)]
struct GuessRequest {
    guess: String,
    #[serde(rename = "gameId")]
    game_id: u32,
    #[serde(rename = "guessNumber")]
    guess_number: u32,
    #[serde(default)]
    player: Option<String>,
}

#[derive(Serialize, ToSchema)]
struct GuessResponse {
    guess: String,
    results: Vec<game::LetterResult>,
    won: bool,
    #[serde(rename = "gameOver")]
    game_over: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    answer: Option<String>,
}

#[derive(Serialize, ToSchema)]
struct ErrorResponse {
    error: String,
}

#[utoipa::path(
    get,
    path = "/api/game",
    responses(
        (status = 200, description = "Current daily game", body = GameResponse),
        (status = 500, description = "Internal error", body = ErrorResponse),
    )
)]
async fn get_game<R: GameRepository>(State(state): State<Arc<AppState<R>>>) -> impl IntoResponse {
    let game_id = game::get_game_id();
    let game_id_str = game_id.to_string();
    debug!(game_id, "GET /api/game");

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

#[utoipa::path(
    post,
    path = "/api/guess",
    request_body = GuessRequest,
    responses(
        (status = 200, description = "Guess evaluation result", body = GuessResponse),
        (status = 400, description = "Invalid guess", body = ErrorResponse),
        (status = 500, description = "Internal error", body = ErrorResponse),
    )
)]
async fn post_guess<R: GameRepository>(
    State(state): State<Arc<AppState<R>>>,
    Json(req): Json<GuessRequest>,
) -> impl IntoResponse {
    let normalized = req.guess.to_lowercase();
    debug!(
        guess = %normalized,
        game_id = req.game_id,
        guess_number = req.guess_number,
        player = ?req.player,
        "POST /api/guess"
    );

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

#[derive(Deserialize, IntoParams)]
struct LeaderboardQuery {
    #[serde(default = "default_limit")]
    limit: u32,
    #[serde(default)]
    offset: u32,
}

fn default_limit() -> u32 {
    20
}

#[derive(Deserialize, IntoParams)]
struct DailyQuery {
    #[serde(rename = "gameId")]
    game_id: u32,
}

#[utoipa::path(
    get,
    path = "/api/leaderboard",
    params(LeaderboardQuery),
    responses(
        (status = 200, description = "Leaderboard entries", body = Vec<LeaderboardEntry>),
        (status = 500, description = "Internal error", body = ErrorResponse),
    )
)]
async fn get_leaderboard<R: GameRepository>(
    State(state): State<Arc<AppState<R>>>,
    Query(query): Query<LeaderboardQuery>,
) -> impl IntoResponse {
    debug!(
        limit = query.limit,
        offset = query.offset,
        "GET /api/leaderboard"
    );
    match state.repo.get_leaderboard(query.limit, query.offset).await {
        Ok(entries) => (StatusCode::OK, Json(serde_json::to_value(entries).unwrap())),
        Err(e) => {
            error!("Failed to fetch leaderboard: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(
                    serde_json::to_value(ErrorResponse {
                        error: "Failed to fetch leaderboard".into(),
                    })
                    .unwrap(),
                ),
            )
        }
    }
}

#[utoipa::path(
    get,
    path = "/api/leaderboard/daily",
    params(DailyQuery),
    responses(
        (status = 200, description = "Daily game results", body = Vec<DailyResult>),
        (status = 500, description = "Internal error", body = ErrorResponse),
    )
)]
async fn get_daily_leaderboard<R: GameRepository>(
    State(state): State<Arc<AppState<R>>>,
    Query(query): Query<DailyQuery>,
) -> impl IntoResponse {
    let game_id = query.game_id.to_string();
    debug!(%game_id, "GET /api/leaderboard/daily");
    match state.repo.get_daily_results(&game_id).await {
        Ok(results) => (StatusCode::OK, Json(serde_json::to_value(results).unwrap())),
        Err(e) => {
            error!("Failed to fetch daily results: {e}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(
                    serde_json::to_value(ErrorResponse {
                        error: "Failed to fetch daily results".into(),
                    })
                    .unwrap(),
                ),
            )
        }
    }
}

#[utoipa::path(
    get,
    path = "/health",
    responses(
        (status = 200, description = "Health check", body = String),
    )
)]
async fn health() -> &'static str {
    "ok"
}

#[utoipa::path(
    get,
    path = "/api/config",
    responses(
        (status = 200, description = "Contract configuration", body = ContractConfig),
        (status = 503, description = "Resolver not configured", body = ErrorResponse),
    )
)]
async fn get_config<R: GameRepository>(State(state): State<Arc<AppState<R>>>) -> impl IntoResponse {
    debug!("GET /api/config");
    match &state.contract_config {
        Some(config) => (StatusCode::OK, Json(serde_json::to_value(config).unwrap())),
        None => (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(
                serde_json::to_value(ErrorResponse {
                    error: "Resolver not configured".into(),
                })
                .unwrap(),
            ),
        ),
    }
}

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Word Circles API",
        description = "Backend API for the Word Circles daily word game",
    ),
    paths(
        health,
        get_config,
        get_game,
        post_guess,
        get_leaderboard,
        get_daily_leaderboard
    ),
    components(schemas(
        GameResponse,
        GuessRequest,
        GuessResponse,
        ErrorResponse,
        game::LetterResult,
        ContractConfig,
        LeaderboardEntry,
        DailyResult,
    ))
)]
struct ApiDoc;

pub fn build_router<R: GameRepository>(repo: R, contract_config: Option<ContractConfig>) -> Router {
    let state = Arc::new(AppState {
        repo,
        contract_config,
    });
    Router::new()
        .route("/health", get(health))
        .route("/api/config", get(get_config::<R>))
        .route("/api/game", get(get_game::<R>))
        .route("/api/guess", post(post_guess::<R>))
        .route("/api/leaderboard", get(get_leaderboard::<R>))
        .route("/api/leaderboard/daily", get(get_daily_leaderboard::<R>))
        .with_state(state)
        .merge(SwaggerUi::new("/swagger-ui").url("/api-docs/openapi.json", ApiDoc::openapi()))
        .layer(CorsLayer::permissive())
}
