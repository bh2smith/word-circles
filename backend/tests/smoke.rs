use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;
use word_circles_backend::build_router;
use word_circles_backend::db::models::GameRecord;
use word_circles_backend::db::repository::GameRepository;
use word_circles_backend::db::sqlite::SqliteRepository;

fn app() -> axum::Router {
    let repo = SqliteRepository::new(":memory:").unwrap();
    build_router(repo, None, None)
}

async fn json_body(resp: axum::response::Response) -> serde_json::Value {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn health_check() {
    let resp = app()
        .oneshot(Request::get("/health").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&bytes[..], b"ok");
}

#[tokio::test]
async fn get_game_returns_game_id() {
    let body = json_body(
        app()
            .oneshot(Request::get("/api/game").body(Body::empty()).unwrap())
            .await
            .unwrap(),
    )
    .await;

    assert!(body["gameId"].is_number());
}

#[tokio::test]
async fn get_game_is_idempotent() {
    let app = app();

    let body1 = json_body(
        app.clone()
            .oneshot(Request::get("/api/game").body(Body::empty()).unwrap())
            .await
            .unwrap(),
    )
    .await;

    let body2 = json_body(
        app.oneshot(Request::get("/api/game").body(Body::empty()).unwrap())
            .await
            .unwrap(),
    )
    .await;

    assert_eq!(body1["gameId"], body2["gameId"]);
}

fn guess_request(game_id: u64, guess: &str, guess_number: u32) -> Request<Body> {
    let payload = serde_json::json!({
        "guess": guess,
        "gameId": game_id.to_string(),
        "guessNumber": guess_number,
    });
    Request::post("/api/guess")
        .header("content-type", "application/json")
        .body(Body::from(payload.to_string()))
        .unwrap()
}

fn guess_request_with_player(
    game_id: u64,
    guess: &str,
    guess_number: u32,
    player: &str,
) -> Request<Body> {
    let payload = serde_json::json!({
        "guess": guess,
        "gameId": game_id.to_string(),
        "guessNumber": guess_number,
        "player": player,
    });
    Request::post("/api/guess")
        .header("content-type", "application/json")
        .body(Body::from(payload.to_string()))
        .unwrap()
}

#[tokio::test]
async fn valid_guess_returns_results() {
    let app = app();

    let game_body = json_body(
        app.clone()
            .oneshot(Request::get("/api/game").body(Body::empty()).unwrap())
            .await
            .unwrap(),
    )
    .await;
    let game_id = game_body["gameId"].as_u64().unwrap();

    let resp = app
        .oneshot(guess_request(game_id, "crane", 0))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = json_body(resp).await;
    assert_eq!(body["guess"], "crane");
    assert!(body["results"].is_array());
    assert_eq!(body["results"].as_array().unwrap().len(), 5);
    assert!(body["won"].is_boolean());
    assert!(body["gameOver"].is_boolean());
}

#[tokio::test]
async fn invalid_word_returns_400() {
    let resp = app().oneshot(guess_request(1, "zzzzz", 0)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    let body = json_body(resp).await;
    assert_eq!(body["error"], "Not in word list");
}

#[tokio::test]
async fn too_short_returns_400() {
    let resp = app().oneshot(guess_request(1, "hi", 0)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    let body = json_body(resp).await;
    assert_eq!(body["error"], "Guess must be 5 letters");
}

#[tokio::test]
async fn guess_number_out_of_range_returns_400() {
    let resp = app().oneshot(guess_request(1, "crane", 6)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    let body = json_body(resp).await;
    assert_eq!(body["error"], "Invalid guess number");
}

#[tokio::test]
async fn guess_with_player_persists() {
    let app = app();

    let game_body = json_body(
        app.clone()
            .oneshot(Request::get("/api/game").body(Body::empty()).unwrap())
            .await
            .unwrap(),
    )
    .await;
    let game_id = game_body["gameId"].as_u64().unwrap();

    let resp = app
        .oneshot(guess_request_with_player(game_id, "slate", 0, "0xtest"))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = json_body(resp).await;
    assert_eq!(body["guess"], "slate");
    assert!(body["results"].is_array());
}

#[tokio::test]
async fn uppercase_guess_is_normalized() {
    let resp = app().oneshot(guess_request(1, "CRANE", 0)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = json_body(resp).await;
    assert_eq!(body["guess"], "crane");
}

#[tokio::test]
async fn last_guess_reveals_answer() {
    let app = app();

    let game_body = json_body(
        app.clone()
            .oneshot(Request::get("/api/game").body(Body::empty()).unwrap())
            .await
            .unwrap(),
    )
    .await;
    let game_id = game_body["gameId"].as_u64().unwrap();

    let resp = app
        .oneshot(guess_request(game_id, "crane", 5))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = json_body(resp).await;
    assert!(body["gameOver"].as_bool().unwrap());
    assert!(body["answer"].is_string());
}

#[tokio::test]
async fn leaderboard_empty() {
    let resp = app()
        .oneshot(
            Request::get("/api/leaderboard")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = json_body(resp).await;
    assert!(body.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn leaderboard_with_player_data() {
    let app = app();

    let game_body = json_body(
        app.clone()
            .oneshot(Request::get("/api/game").body(Body::empty()).unwrap())
            .await
            .unwrap(),
    )
    .await;
    let game_id = game_body["gameId"].as_u64().unwrap();

    app.clone()
        .oneshot(guess_request_with_player(game_id, "crane", 0, "0xplayer1"))
        .await
        .unwrap();

    let resp = app
        .oneshot(
            Request::get("/api/leaderboard")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = json_body(resp).await;
    let entries = body.as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["address"], "0xplayer1");
    assert_eq!(entries[0]["games_played"], 1);
}

#[tokio::test]
async fn daily_leaderboard_empty() {
    let resp = app()
        .oneshot(
            Request::get("/api/leaderboard/daily?gameId=999")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = json_body(resp).await;
    assert!(body.as_array().unwrap().is_empty());
}

#[tokio::test]
async fn config_without_resolver() {
    let resp = app()
        .oneshot(Request::get("/api/config").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn config_with_resolver() {
    use word_circles_backend::chain::ContractConfig;

    let repo = SqliteRepository::new(":memory:").unwrap();
    let config = ContractConfig {
        resolver: "0x1234567890abcdef1234567890abcdef12345678".into(),
        commitment_address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd".into(),
        stats_address: None,
        pvp_enabled: false,
    };
    let app = build_router(repo, Some(config), None);

    let resp = app
        .oneshot(Request::get("/api/config").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = json_body(resp).await;
    assert_eq!(
        body["resolver"],
        "0x1234567890abcdef1234567890abcdef12345678"
    );
    assert_eq!(
        body["commitmentAddress"],
        "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
    );
    assert!(body.get("statsAddress").is_none());
    assert_eq!(body["pvpEnabled"], false);
}

#[tokio::test]
async fn config_with_pvp_enabled() {
    use word_circles_backend::chain::ContractConfig;

    let repo = SqliteRepository::new(":memory:").unwrap();
    let config = ContractConfig {
        resolver: "0x1234567890abcdef1234567890abcdef12345678".into(),
        commitment_address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd".into(),
        stats_address: None,
        pvp_enabled: true,
    };
    let app = build_router(repo, Some(config), None);

    let resp = app
        .oneshot(Request::get("/api/config").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = json_body(resp).await;
    assert_eq!(body["pvpEnabled"], true);
}

#[tokio::test]
async fn daily_leaderboard_with_results() {
    let app = app();

    let game_body = json_body(
        app.clone()
            .oneshot(Request::get("/api/game").body(Body::empty()).unwrap())
            .await
            .unwrap(),
    )
    .await;
    let game_id = game_body["gameId"].as_u64().unwrap();

    app.clone()
        .oneshot(guess_request_with_player(game_id, "crane", 0, "0xdaily1"))
        .await
        .unwrap();

    let resp = app
        .oneshot(
            Request::get(&format!("/api/leaderboard/daily?gameId={game_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = json_body(resp).await;
    let results = body.as_array().unwrap();
    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["address"], "0xdaily1");
    assert_eq!(results[0]["guesses"], 1);
}

// --- PvP tests ---

async fn setup_pvp_game(repo: &SqliteRepository) -> String {
    let game_id = "0xdeadbeef00000000000000000000000000000000000000000000000000000001";
    let game = GameRecord {
        id: game_id.into(),
        game_type: "pvp".into(),
        word_index: 0, // "aback" (first answer)
        salt: Some("aa".repeat(32)),
        commitment: Some("bb".repeat(32)),
        status: "active".into(),
        created_at: String::new(),
        capacity: Some(2),
        token: Some("0xtoken".into()),
        amount: Some("10000000000000000000".into()),
        timeout_secs: Some(10800),
    };
    repo.create_game(&game).await.unwrap();

    let p1 = repo.get_or_create_player("0xplayer1").await.unwrap();
    let p2 = repo.get_or_create_player("0xplayer2").await.unwrap();
    repo.add_game_player(game_id, p1.id, "0xplayer1")
        .await
        .unwrap();
    repo.add_game_player(game_id, p2.id, "0xplayer2")
        .await
        .unwrap();

    game_id.to_string()
}

fn pvp_guess(game_id: &str, guess: &str, guess_number: u32, player: &str) -> Request<Body> {
    let payload = serde_json::json!({
        "guess": guess,
        "gameId": game_id,
        "guessNumber": guess_number,
        "player": player,
    });
    Request::post("/api/guess")
        .header("content-type", "application/json")
        .body(Body::from(payload.to_string()))
        .unwrap()
}

#[tokio::test]
async fn pvp_game_status() {
    let repo = SqliteRepository::new(":memory:").unwrap();
    let game_id = setup_pvp_game(&repo).await;
    let app = build_router(repo, None, None);

    let resp = app
        .oneshot(
            Request::get(&format!("/api/games/{game_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = json_body(resp).await;
    assert_eq!(body["gameId"], game_id);
    assert_eq!(body["status"], "active");
    assert_eq!(body["gameType"], "pvp");
    assert_eq!(body["capacity"], 2);
    assert_eq!(body["players"].as_array().unwrap().len(), 2);
    assert!(body["answer"].is_null());
}

#[tokio::test]
async fn pvp_game_not_found() {
    let app = app();
    let resp = app
        .oneshot(
            Request::get("/api/games/0xnonexistent")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn pvp_guess_requires_player() {
    let repo = SqliteRepository::new(":memory:").unwrap();
    let game_id = setup_pvp_game(&repo).await;
    let app = build_router(repo, None, None);

    let payload = serde_json::json!({
        "guess": "crane",
        "gameId": game_id,
        "guessNumber": 0,
    });
    let resp = app
        .oneshot(
            Request::post("/api/guess")
                .header("content-type", "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    let body = json_body(resp).await;
    assert_eq!(body["error"], "Player address required for PvP");
}

#[tokio::test]
async fn pvp_guess_rejects_non_player() {
    let repo = SqliteRepository::new(":memory:").unwrap();
    let game_id = setup_pvp_game(&repo).await;
    let app = build_router(repo, None, None);

    let resp = app
        .oneshot(pvp_guess(&game_id, "crane", 0, "0xstranger"))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn pvp_guess_starts_timer_and_records() {
    let repo = SqliteRepository::new(":memory:").unwrap();
    let game_id = setup_pvp_game(&repo).await;
    let app = build_router(repo, None, None);

    let resp = app
        .clone()
        .oneshot(pvp_guess(&game_id, "crane", 0, "0xplayer1"))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = json_body(resp).await;
    assert_eq!(body["guess"], "crane");
    assert!(body["results"].is_array());
    assert!(body["answer"].is_null()); // PvP never reveals answer mid-game

    // Check game status shows player as "playing"
    let status_resp = app
        .oneshot(
            Request::get(&format!("/api/games/{game_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = json_body(status_resp).await;
    let players = status["players"].as_array().unwrap();
    let p1 = players
        .iter()
        .find(|p| p["address"] == "0xplayer1")
        .unwrap();
    assert_eq!(p1["status"], "playing");
}

#[tokio::test]
async fn pvp_guess_marks_finished_on_last_guess() {
    let repo = SqliteRepository::new(":memory:").unwrap();
    let game_id = setup_pvp_game(&repo).await;
    let app = build_router(repo, None, None);

    // Submit final guess (guess_number=5 is the 6th guess)
    let resp = app
        .clone()
        .oneshot(pvp_guess(&game_id, "crane", 5, "0xplayer1"))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = json_body(resp).await;
    assert!(body["gameOver"].as_bool().unwrap());

    // Check player is finished
    let status_resp = app
        .oneshot(
            Request::get(&format!("/api/games/{game_id}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = json_body(status_resp).await;
    let players = status["players"].as_array().unwrap();
    let p1 = players
        .iter()
        .find(|p| p["address"] == "0xplayer1")
        .unwrap();
    assert_eq!(p1["status"], "finished");
}
