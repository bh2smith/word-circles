use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use sqlx::PgPool;
use tower::ServiceExt;
use word_circles_backend::build_router;
use word_circles_backend::db::models::GameRecord;
use word_circles_backend::db::postgres::PostgresRepository;
use word_circles_backend::db::repository::GameRepository;

fn app(pool: PgPool) -> axum::Router {
    let repo = PostgresRepository::from_pool(pool);
    build_router(repo, None, None)
}

async fn json_body(resp: axum::response::Response) -> serde_json::Value {
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap()
}

#[sqlx::test(migrations = "./migrations")]
async fn health_check(pool: PgPool) {
    let resp = app(pool)
        .oneshot(Request::get("/health").body(Body::empty()).unwrap())
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(&bytes[..], b"ok");
}

#[sqlx::test(migrations = "./migrations")]
async fn get_game_returns_game_id(pool: PgPool) {
    let body = json_body(
        app(pool)
            .oneshot(Request::get("/api/game").body(Body::empty()).unwrap())
            .await
            .unwrap(),
    )
    .await;

    assert!(body["gameId"].is_number());
}

#[sqlx::test(migrations = "./migrations")]
async fn get_game_is_idempotent(pool: PgPool) {
    let app = app(pool);

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

#[sqlx::test(migrations = "./migrations")]
async fn valid_guess_returns_results(pool: PgPool) {
    let app = app(pool);

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

#[sqlx::test(migrations = "./migrations")]
async fn invalid_word_returns_400(pool: PgPool) {
    let resp = app(pool)
        .oneshot(guess_request(1, "zzzzz", 0))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    let body = json_body(resp).await;
    assert_eq!(body["error"], "Not in word list");
}

#[sqlx::test(migrations = "./migrations")]
async fn too_short_returns_400(pool: PgPool) {
    let resp = app(pool).oneshot(guess_request(1, "hi", 0)).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    let body = json_body(resp).await;
    assert_eq!(body["error"], "Guess must be 5 letters");
}

#[sqlx::test(migrations = "./migrations")]
async fn guess_number_out_of_range_returns_400(pool: PgPool) {
    let resp = app(pool)
        .oneshot(guess_request(1, "crane", 6))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    let body = json_body(resp).await;
    assert_eq!(body["error"], "Invalid guess number");
}

#[sqlx::test(migrations = "./migrations")]
async fn guess_with_player_persists(pool: PgPool) {
    let app = app(pool);

    let game_body = json_body(
        app.clone()
            .oneshot(Request::get("/api/game").body(Body::empty()).unwrap())
            .await
            .unwrap(),
    )
    .await;
    let game_id = game_body["gameId"].as_u64().unwrap();

    let resp = app
        .oneshot(guess_request_with_player(
            game_id,
            "slate",
            0,
            "0xcccccccccccccccccccccccccccccccccccccccc",
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = json_body(resp).await;
    assert_eq!(body["guess"], "slate");
    assert!(body["results"].is_array());
}

#[sqlx::test(migrations = "./migrations")]
async fn uppercase_guess_is_normalized(pool: PgPool) {
    let resp = app(pool)
        .oneshot(guess_request(1, "CRANE", 0))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = json_body(resp).await;
    assert_eq!(body["guess"], "crane");
}

#[sqlx::test(migrations = "./migrations")]
async fn last_guess_reveals_answer(pool: PgPool) {
    let app = app(pool);

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

#[sqlx::test(migrations = "./migrations")]
async fn leaderboard_empty(pool: PgPool) {
    let resp = app(pool)
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

#[sqlx::test(migrations = "./migrations")]
async fn leaderboard_with_player_data(pool: PgPool) {
    let app = app(pool);

    let game_body = json_body(
        app.clone()
            .oneshot(Request::get("/api/game").body(Body::empty()).unwrap())
            .await
            .unwrap(),
    )
    .await;
    let game_id = game_body["gameId"].as_u64().unwrap();

    app.clone()
        .oneshot(guess_request_with_player(
            game_id,
            "crane",
            0,
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ))
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
    assert_eq!(
        entries[0]["address"],
        "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    );
    assert_eq!(entries[0]["games_played"], 1);
}

#[sqlx::test(migrations = "./migrations")]
async fn daily_leaderboard_empty(pool: PgPool) {
    let resp = app(pool)
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

#[sqlx::test(migrations = "./migrations")]
async fn config_without_resolver(pool: PgPool) {
    let resp = app(pool)
        .oneshot(Request::get("/api/config").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[sqlx::test(migrations = "./migrations")]
async fn config_with_resolver(pool: PgPool) {
    use word_circles_backend::chain::ContractConfig;

    let repo = PostgresRepository::from_pool(pool);
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

#[sqlx::test(migrations = "./migrations")]
async fn config_with_pvp_enabled(pool: PgPool) {
    use word_circles_backend::chain::ContractConfig;

    let repo = PostgresRepository::from_pool(pool);
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

#[sqlx::test(migrations = "./migrations")]
async fn daily_leaderboard_with_results(pool: PgPool) {
    let app = app(pool);

    let game_body = json_body(
        app.clone()
            .oneshot(Request::get("/api/game").body(Body::empty()).unwrap())
            .await
            .unwrap(),
    )
    .await;
    let game_id = game_body["gameId"].as_u64().unwrap();

    app.clone()
        .oneshot(guess_request_with_player(
            game_id,
            "crane",
            0,
            "0xdddddddddddddddddddddddddddddddddddddddd",
        ))
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
    assert_eq!(
        results[0]["address"],
        "0xdddddddddddddddddddddddddddddddddddddddd"
    );
    assert_eq!(results[0]["guesses"], 1);
}

// --- PvP tests ---

async fn setup_pvp_game(repo: &PostgresRepository) -> String {
    let game_id = "0xdeadbeef00000000000000000000000000000000000000000000000000000001";
    let game = GameRecord {
        id: game_id.into(),
        game_type: "pvp".into(),
        word_index: 0,
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

    let p1 = repo
        .get_or_create_player("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        .await
        .unwrap();
    let p2 = repo
        .get_or_create_player("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        .await
        .unwrap();
    repo.add_game_player(game_id, p1.id, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        .await
        .unwrap();
    repo.add_game_player(game_id, p2.id, "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
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

#[sqlx::test(migrations = "./migrations")]
async fn pvp_game_status(pool: PgPool) {
    let repo = PostgresRepository::from_pool(pool.clone());
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

#[sqlx::test(migrations = "./migrations")]
async fn pvp_game_not_found(pool: PgPool) {
    let app = app(pool);
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

#[sqlx::test(migrations = "./migrations")]
async fn pvp_guess_requires_player(pool: PgPool) {
    let repo = PostgresRepository::from_pool(pool.clone());
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

#[sqlx::test(migrations = "./migrations")]
async fn pvp_guess_rejects_non_player(pool: PgPool) {
    let repo = PostgresRepository::from_pool(pool.clone());
    let game_id = setup_pvp_game(&repo).await;
    let app = build_router(repo, None, None);

    let resp = app
        .oneshot(pvp_guess(
            &game_id,
            "crane",
            0,
            "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[sqlx::test(migrations = "./migrations")]
async fn pvp_guess_starts_timer_and_records(pool: PgPool) {
    let repo = PostgresRepository::from_pool(pool.clone());
    let game_id = setup_pvp_game(&repo).await;
    let app = build_router(repo, None, None);

    let resp = app
        .clone()
        .oneshot(pvp_guess(
            &game_id,
            "crane",
            0,
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = json_body(resp).await;
    assert_eq!(body["guess"], "crane");
    assert!(body["results"].is_array());
    assert!(body["answer"].is_null());

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
        .find(|p| p["address"] == "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        .unwrap();
    assert_eq!(p1["status"], "playing");
}

#[sqlx::test(migrations = "./migrations")]
async fn pvp_guess_marks_finished_on_last_guess(pool: PgPool) {
    let repo = PostgresRepository::from_pool(pool.clone());
    let game_id = setup_pvp_game(&repo).await;
    let app = build_router(repo, None, None);

    let resp = app
        .clone()
        .oneshot(pvp_guess(
            &game_id,
            "crane",
            5,
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = json_body(resp).await;
    assert!(body["gameOver"].as_bool().unwrap());

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
        .find(|p| p["address"] == "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        .unwrap();
    assert_eq!(p1["status"], "finished");
}
