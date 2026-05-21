use std::sync::Arc;
use std::time::Duration;
use word_circles_backend::build_router;
use word_circles_backend::db::sqlite::SqliteRepository;
use word_circles_backend::indexer;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    let port = std::env::var("PORT").unwrap_or_else(|_| "3001".into());
    let db_path = std::env::var("DATABASE_PATH").unwrap_or_else(|_| "word-circles.db".into());
    let addr = format!("0.0.0.0:{port}");

    let repo = SqliteRepository::new(&db_path).expect("Failed to initialize database");

    if let Ok(arak_db) = std::env::var("ARAK_DB_PATH") {
        let poll_secs: u64 = std::env::var("INDEXER_POLL_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(5);

        let config = indexer::IndexerConfig {
            arak_db_path: arak_db,
            poll_interval: Duration::from_secs(poll_secs),
        };

        let indexer_repo = Arc::new(
            SqliteRepository::new(&db_path).expect("Failed to initialize indexer database"),
        );
        tokio::spawn(async move {
            indexer::run(indexer_repo, config).await;
        });

        tracing::info!("Event listener enabled (polling arak)");
    }

    let app = build_router(repo);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    println!("Backend listening on {addr}");
    axum::serve(listener, app).await.unwrap();
}
