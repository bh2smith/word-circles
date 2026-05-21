use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use tower::ServiceExt;
use word_circles_backend::build_router;
use word_circles_backend::db::sqlite::SqliteRepository;

fn app() -> axum::Router {
    let repo = SqliteRepository::new(":memory:").unwrap();
    build_router(repo)
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
        "gameId": game_id,
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
