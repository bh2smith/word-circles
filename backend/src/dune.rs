use duners::DuneClient;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct GameRecorded {
    pub player: String,
    pub game_id: u64,
    pub won: bool,
    pub guesses: u32,
    pub block_number: u64,
}

pub async fn fetch_game_recorded_events(query_id: u32) -> Result<Vec<GameRecorded>, String> {
    let client = DuneClient::from_env();
    let response = client
        .refresh::<GameRecorded>(query_id, None, None)
        .await
        .map_err(|e| format!("Dune query failed: {e:?}"))?;
    Ok(response.get_rows().to_vec())
}
