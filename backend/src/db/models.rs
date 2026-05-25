use serde::Serialize;
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct GameRecord {
    pub id: String,
    pub game_type: String,
    pub word_index: usize,
    pub salt: Option<String>,
    pub commitment: Option<String>,
    pub status: String,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capacity: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u32>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct GamePlayerRecord {
    pub game_id: String,
    pub player_id: i64,
    pub address: String,
    pub started_at: Option<String>,
    pub finished_at: Option<String>,
    pub solved: bool,
    pub guess_count: u32,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PlayerRecord {
    pub id: i64,
    pub address: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct LeaderboardEntry {
    pub address: String,
    pub wins: u32,
    pub games_played: u32,
    pub avg_guesses: f64,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct DailyResult {
    pub address: String,
    pub guesses: u32,
    pub solved: bool,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct GuessRecord {
    pub id: Option<i64>,
    pub game_id: String,
    pub player_id: i64,
    pub guess_number: u32,
    pub word: String,
    pub results: String,
    pub is_correct: bool,
    pub created_at: Option<String>,
}
