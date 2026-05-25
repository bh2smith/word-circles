use std::sync::Arc;
use std::time::Duration;
use tracing_subscriber::EnvFilter;
use word_circles_backend::build_router;
use word_circles_backend::chain::ResolverClient;
use word_circles_backend::db::sqlite::SqliteRepository;
use word_circles_backend::indexer;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
    let port = std::env::var("PORT").unwrap_or_else(|_| "3001".into());
    let db_path = std::env::var("DATABASE_PATH").unwrap_or_else(|_| "word-circles.db".into());
    let addr = format!("0.0.0.0:{port}");

    let repo = SqliteRepository::new(&db_path).expect("Failed to initialize database");

    let pvp_enabled = std::env::var("PVP_ENABLED")
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false);

    if pvp_enabled {
        tracing::info!("PvP mode enabled");
    }

    let resolver = match ResolverClient::from_env() {
        Ok(client) => {
            tracing::info!(
                address = %client.address(),
                commitment = %client.commitment_address,
                "Resolver wallet loaded"
            );
            Some(Arc::new(client))
        }
        Err(e) => {
            tracing::warn!("Resolver wallet not configured: {e}");
            None
        }
    };

    if let Ok(arak_db) = std::env::var("ARAK_DB_PATH") {
        let poll_secs: u64 = std::env::var("INDEXER_POLL_SECS")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(5);

        let config = indexer::IndexerConfig {
            arak_db_path: arak_db,
            poll_interval: Duration::from_secs(poll_secs),
            resolver: resolver.clone(),
            pvp_enabled,
        };

        let indexer_repo = Arc::new(
            SqliteRepository::new(&db_path).expect("Failed to initialize indexer database"),
        );
        tokio::spawn(async move {
            indexer::run(indexer_repo, config).await;
        });

        tracing::info!("Event listener enabled (polling arak)");
    }

    let contract_config = resolver.as_ref().map(|r| r.config(pvp_enabled));
    let app = build_router(repo, contract_config);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    println!("Backend listening on {addr}");
    axum::serve(listener, app).await.unwrap();
}
