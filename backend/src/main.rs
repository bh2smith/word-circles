use word_circles_backend::build_router;
use word_circles_backend::db::sqlite::SqliteRepository;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();
    let port = std::env::var("PORT").unwrap_or_else(|_| "3001".into());
    let db_path = std::env::var("DATABASE_PATH").unwrap_or_else(|_| "word-circles.db".into());
    let addr = format!("0.0.0.0:{port}");

    let repo = SqliteRepository::new(&db_path).expect("Failed to initialize database");
    let app = build_router(repo);

    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    println!("Backend listening on {addr}");
    axum::serve(listener, app).await.unwrap();
}
