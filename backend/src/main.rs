use std::sync::Arc;
use std::time::Duration;
use tracing_subscriber::EnvFilter;
use word_circles_backend::build_router;
use word_circles_backend::chain::ResolverClient;
use word_circles_backend::db::repository::GameRepository;
use word_circles_backend::db::sqlite::SqliteRepository;
use word_circles_backend::dune;
use word_circles_backend::indexer;
use word_circles_backend::settlement;

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

    if let Ok(query_id) = std::env::var("DUNE_QUERY_ID") {
        let query_id: u32 = query_id.parse().expect("DUNE_QUERY_ID must be a number");
        run_bootstrap(&repo, query_id).await;
    }

    let pvp_enabled = std::env::var("PVP_ENABLED")
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false);

    let pvp_timeout_secs: u32 = std::env::var("PVP_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(10800);

    if pvp_enabled {
        tracing::info!(timeout_secs = pvp_timeout_secs, "PvP mode enabled");
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
            pvp_timeout_secs,
        };

        let indexer_repo = Arc::new(
            SqliteRepository::new(&db_path).expect("Failed to initialize indexer database"),
        );
        tokio::spawn(async move {
            indexer::run(indexer_repo, config).await;
        });

        tracing::info!("Event listener enabled (polling arak)");
    }

    if pvp_enabled {
        if let Some(ref resolver) = resolver {
            let timeout_poll_secs: u64 = std::env::var("TIMEOUT_POLL_SECS")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(30);
            let timeout_repo = Arc::new(
                SqliteRepository::new(&db_path).expect("Failed to initialize timeout database"),
            );
            let timeout_resolver = Arc::clone(resolver);
            tokio::spawn(async move {
                settlement::run_timeout_loop(
                    timeout_repo,
                    timeout_resolver,
                    Duration::from_secs(timeout_poll_secs),
                    pvp_timeout_secs,
                )
                .await;
            });
            tracing::info!(
                poll_secs = timeout_poll_secs,
                "Settlement timeout loop enabled"
            );
        }
    }

    let contract_config = resolver.as_ref().map(|r| r.config(pvp_enabled));
    let app = build_router(repo, contract_config, resolver);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    println!("Backend listening on {addr}");
    axum::serve(listener, app).await.unwrap();
}

async fn run_bootstrap(repo: &SqliteRepository, query_id: u32) {
    tracing::info!(
        query_id,
        "Bootstrap: fetching GameRecorded events from Dune"
    );

    let events = match dune::fetch_game_recorded_events(query_id).await {
        Ok(events) => events,
        Err(e) => {
            tracing::error!("Bootstrap failed: {e}");
            return;
        }
    };

    tracing::info!(count = events.len(), "Bootstrap: fetched records from Dune");

    let mut backfilled = 0u64;
    let mut max_block: u64 = 0;

    for event in &events {
        indexer::backfill_game_result(
            repo,
            event.game_id as u32,
            &event.player,
            event.won,
            event.guesses as u8,
        )
        .await;
        backfilled += 1;
        if event.block_number > max_block {
            max_block = event.block_number;
        }
    }

    if max_block > 0 {
        let current_cursor = repo.get_indexer_cursor().await.unwrap_or(0);
        if max_block > current_cursor {
            repo.set_indexer_cursor(max_block)
                .await
                .expect("Failed to set indexer cursor");
            tracing::info!(block = max_block, "Bootstrap: indexer cursor set");
        } else {
            tracing::info!(
                current_cursor,
                max_block,
                "Bootstrap: cursor already ahead, not updating"
            );
        }
    }

    tracing::info!(backfilled, max_block, "Bootstrap complete");
}
