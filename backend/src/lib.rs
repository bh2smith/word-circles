pub mod chain;
pub mod db;
pub mod dune;
pub mod game;
pub mod indexer;
pub mod settlement;
mod words;

use axum::{
    Router,
    extract::{Json, Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
};
use chain::ContractConfig;
use db::{
    models::{DailyResult, GamePlayerRecord, GameRecord, GuessRecord, LeaderboardEntry},
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
    resolver: Option<Arc<chain::ResolverClient>>,
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
    game_id: String,
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
                capacity: None,
                token: None,
                amount: None,
                timeout_secs: None,
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
        game_id = %req.game_id,
        guess_number = req.guess_number,
        player = ?req.player,
        "POST /api/guess"
    );

    if normalized.len() != game::WORD_LENGTH || !normalized.bytes().all(|b| b.is_ascii_lowercase())
    {
        return err_response(StatusCode::BAD_REQUEST, "Guess must be 5 letters");
    }

    if !game::is_valid_guess(&normalized) {
        return err_response(StatusCode::BAD_REQUEST, "Not in word list");
    }

    if req.guess_number >= game::MAX_GUESSES as u32 {
        return err_response(StatusCode::BAD_REQUEST, "Invalid guess number");
    }

    let game_id_str = &req.game_id;

    let game_record = match state.repo.get_game(game_id_str).await {
        Ok(Some(g)) => g,
        Ok(None) => {
            let daily_id: u32 = match game_id_str.parse() {
                Ok(id) => id,
                Err(_) => return err_response(StatusCode::NOT_FOUND, "Game not found"),
            };
            let word_index = game::answer_index(daily_id);
            GameRecord {
                id: game_id_str.clone(),
                game_type: "daily".into(),
                word_index,
                salt: None,
                commitment: None,
                status: "active".into(),
                created_at: String::new(),
                capacity: None,
                token: None,
                amount: None,
                timeout_secs: None,
            }
        }
        Err(e) => {
            error!("Failed to fetch game {game_id_str}: {e}");
            return err_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to fetch game");
        }
    };

    let is_pvp = game_record.game_type == "pvp";

    if is_pvp {
        if game_record.status != "active" {
            return err_response(StatusCode::BAD_REQUEST, "Game is not active");
        }

        let address = match &req.player {
            Some(a) => a,
            None => {
                return err_response(StatusCode::BAD_REQUEST, "Player address required for PvP");
            }
        };

        let players = match state.repo.get_game_players(game_id_str).await {
            Ok(p) => p,
            Err(e) => {
                error!("Failed to fetch game players: {e}");
                return err_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to fetch players");
            }
        };

        let game_player = match players.iter().find(|p| p.address == *address) {
            Some(p) => p,
            None => return err_response(StatusCode::FORBIDDEN, "Not a player in this game"),
        };

        if game_player.finished_at.is_some() {
            return err_response(StatusCode::BAD_REQUEST, "Already finished");
        }

        if let (Some(started), Some(timeout)) = (&game_player.started_at, game_record.timeout_secs)
        {
            if is_timed_out(started, timeout) {
                return err_response(StatusCode::BAD_REQUEST, "Time expired");
            }
        }

        let player_record = match state.repo.get_or_create_player(address).await {
            Ok(p) => p,
            Err(e) => {
                error!("Failed to get player: {e}");
                return err_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to get player");
            }
        };

        if game_player.started_at.is_none() {
            let _ = state
                .repo
                .update_game_player_started(game_id_str, player_record.id)
                .await;
        }

        let answer = game::get_answer_by_index(game_record.word_index);
        let results = game::evaluate_guess(&normalized, answer);
        let won = results.iter().all(|r| *r == game::LetterResult::Correct);
        let game_over = won || req.guess_number >= game::MAX_GUESSES as u32 - 1;

        let results_json = serde_json::to_string(&results).unwrap_or_default();
        let guess_record = GuessRecord {
            id: None,
            game_id: game_id_str.clone(),
            player_id: player_record.id,
            guess_number: req.guess_number,
            word: normalized.clone(),
            results: results_json,
            is_correct: won,
            created_at: None,
        };
        if let Err(e) = state.repo.record_guess(&guess_record).await {
            error!("Failed to record guess for game {game_id_str}: {e}");
            return err_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to record guess");
        }

        if game_over {
            let _ = state
                .repo
                .update_game_player_finished(
                    game_id_str,
                    player_record.id,
                    won,
                    req.guess_number + 1,
                )
                .await;

            if let Ok(updated_players) = state.repo.get_game_players(game_id_str).await {
                let all_done = updated_players.iter().all(|p| p.finished_at.is_some());
                if all_done {
                    tracing::info!(game_id = %game_id_str, "All players finished — settlement pending");
                }
            }
        }

        let response = GuessResponse {
            guess: normalized,
            results: results.to_vec(),
            won,
            game_over,
            answer: None, // never reveal in PvP until settled
        };

        return (
            StatusCode::OK,
            Json(serde_json::to_value(response).unwrap()),
        );
    }

    // Daily game path
    let answer = game::get_answer_by_index(game_record.word_index);
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
                return err_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to record guess");
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

fn err_response(status: StatusCode, msg: &str) -> (StatusCode, Json<serde_json::Value>) {
    (
        status,
        Json(serde_json::to_value(ErrorResponse { error: msg.into() }).unwrap()),
    )
}

fn is_timed_out(started_at: &str, timeout_secs: u32) -> bool {
    let Ok(started) = chrono::NaiveDateTime::parse_from_str(started_at, "%Y-%m-%dT%H:%M:%SZ")
    else {
        return false;
    };
    let now = chrono::Utc::now().naive_utc();
    let elapsed = now.signed_duration_since(started);
    elapsed.num_seconds() > timeout_secs as i64
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

#[derive(Serialize, ToSchema)]
struct PvpPlayerStatus {
    address: String,
    status: String,
    #[serde(rename = "guessCount")]
    guess_count: u32,
}

#[derive(Serialize, ToSchema)]
struct PvpGameResponse {
    #[serde(rename = "gameId")]
    game_id: String,
    status: String,
    #[serde(rename = "gameType")]
    game_type: String,
    capacity: u32,
    players: Vec<PvpPlayerStatus>,
    #[serde(rename = "timeoutSecs")]
    timeout_secs: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    answer: Option<String>,
}

fn player_status(p: &GamePlayerRecord) -> String {
    if p.finished_at.is_some() {
        "finished".into()
    } else if p.started_at.is_some() {
        "playing".into()
    } else {
        "not_started".into()
    }
}

fn is_valid_address(s: &str) -> bool {
    let body = s.strip_prefix("0x").unwrap_or(s);
    body.len() == 40 && body.chars().all(|c| c.is_ascii_hexdigit())
}

/// Builds the public PvP view of a game: per-player status (no guess details)
/// plus the answer once settled. Shared by the single-game and per-player
/// lookups so both stay in sync on the no-spoiler rule.
async fn build_pvp_response<R: GameRepository>(
    state: &AppState<R>,
    game: GameRecord,
) -> PvpGameResponse {
    let players = state
        .repo
        .get_game_players(&game.id)
        .await
        .unwrap_or_default();

    let player_statuses: Vec<PvpPlayerStatus> = players
        .iter()
        .map(|p| PvpPlayerStatus {
            address: p.address.clone(),
            status: player_status(p),
            guess_count: p.guess_count,
        })
        .collect();

    let answer = if game.status == "settled" || game.status == "completed" {
        Some(game::get_answer_by_index(game.word_index).to_string())
    } else {
        None
    };

    PvpGameResponse {
        game_id: game.id,
        status: game.status,
        game_type: game.game_type,
        capacity: game.capacity.unwrap_or(2),
        players: player_statuses,
        timeout_secs: game.timeout_secs.unwrap_or(10800),
        answer,
    }
}

#[utoipa::path(
    get,
    path = "/api/games/{game_id}",
    params(("game_id" = String, Path, description = "PvP game ID")),
    responses(
        (status = 200, description = "PvP game state", body = PvpGameResponse),
        (status = 404, description = "Game not found", body = ErrorResponse),
        (status = 500, description = "Internal error", body = ErrorResponse),
    )
)]
async fn get_pvp_game<R: GameRepository>(
    State(state): State<Arc<AppState<R>>>,
    Path(game_id): Path<String>,
) -> impl IntoResponse {
    debug!(%game_id, "GET /api/games/:id");

    let game = match state.repo.get_game(&game_id).await {
        Ok(Some(g)) => g,
        Ok(None) => return err_response(StatusCode::NOT_FOUND, "Game not found"),
        Err(e) => {
            error!("Failed to fetch game {game_id}: {e}");
            return err_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to fetch game");
        }
    };

    let response = build_pvp_response(&state, game).await;

    (
        StatusCode::OK,
        Json(serde_json::to_value(response).unwrap()),
    )
}

#[derive(Deserialize, IntoParams)]
struct PlayerGamesQuery {
    /// Player address (0x-prefixed) to look up PvP games for.
    player: String,
    /// Limit to games still in progress (waiting/active).
    #[serde(default)]
    active: bool,
}

#[utoipa::path(
    get,
    path = "/api/games",
    params(PlayerGamesQuery),
    responses(
        (status = 200, description = "PvP games for a player, most recent first", body = Vec<PvpGameResponse>),
        (status = 400, description = "Invalid player address", body = ErrorResponse),
        (status = 500, description = "Internal error", body = ErrorResponse),
    )
)]
async fn get_player_games<R: GameRepository>(
    State(state): State<Arc<AppState<R>>>,
    Query(q): Query<PlayerGamesQuery>,
) -> impl IntoResponse {
    debug!(player = %q.player, active = q.active, "GET /api/games");

    if !is_valid_address(&q.player) {
        return err_response(StatusCode::BAD_REQUEST, "Invalid player address");
    }

    let games = match state.repo.get_games_by_player(&q.player, q.active).await {
        Ok(games) => games,
        Err(e) => {
            error!("Failed to fetch games for {}: {e}", q.player);
            return err_response(StatusCode::INTERNAL_SERVER_ERROR, "Failed to fetch games");
        }
    };

    let mut responses = Vec::with_capacity(games.len());
    for game in games {
        responses.push(build_pvp_response(&state, game).await);
    }

    (
        StatusCode::OK,
        Json(serde_json::to_value(responses).unwrap()),
    )
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
        get_daily_leaderboard,
        get_pvp_game,
        get_player_games,
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
        PvpGameResponse,
        PvpPlayerStatus,
    ))
)]
pub struct ApiDoc;

pub fn build_router<R: GameRepository>(
    repo: R,
    contract_config: Option<ContractConfig>,
    resolver: Option<Arc<chain::ResolverClient>>,
) -> Router {
    let state = Arc::new(AppState {
        repo,
        contract_config,
        resolver,
    });
    Router::new()
        .route("/health", get(health))
        .route("/api/config", get(get_config::<R>))
        .route("/api/game", get(get_game::<R>))
        .route("/api/games", get(get_player_games::<R>))
        .route("/api/games/{game_id}", get(get_pvp_game::<R>))
        .route("/api/guess", post(post_guess::<R>))
        .route("/api/leaderboard", get(get_leaderboard::<R>))
        .route("/api/leaderboard/daily", get(get_daily_leaderboard::<R>))
        .with_state(state)
        .merge(SwaggerUi::new("/swagger-ui").url("/api-docs/openapi.json", ApiDoc::openapi()))
        .layer(CorsLayer::permissive())
}
