use serde::Deserialize;
use std::time::Duration;

const DUNE_API_BASE: &str = "https://api.dune.com/api/v1";

#[derive(Debug, Clone)]
pub struct GameRecorded {
    pub player: String,
    pub game_id: u32,
    pub won: bool,
    pub guesses: u8,
    pub block_number: u64,
}

#[derive(Deserialize)]
struct ExecuteResponse {
    execution_id: String,
}

#[derive(Deserialize)]
struct ResultsResponse {
    state: String,
    result: Option<ResultData>,
}

#[derive(Deserialize)]
struct ResultData {
    rows: Vec<ResultRow>,
}

#[derive(Deserialize)]
struct ResultRow {
    player: String,
    #[serde(alias = "gameId", alias = "game_id")]
    game_id: serde_json::Value,
    won: serde_json::Value,
    guesses: serde_json::Value,
    block_number: serde_json::Value,
}

impl ResultRow {
    fn into_game_recorded(self) -> GameRecorded {
        let game_id = match &self.game_id {
            serde_json::Value::Number(n) => n.as_u64().unwrap_or(0) as u32,
            serde_json::Value::String(s) => s.parse().unwrap_or(0),
            _ => 0,
        };
        let won = match &self.won {
            serde_json::Value::Bool(b) => *b,
            serde_json::Value::Number(n) => n.as_u64().unwrap_or(0) != 0,
            serde_json::Value::String(s) => s == "true" || s == "1",
            _ => false,
        };
        let guesses = match &self.guesses {
            serde_json::Value::Number(n) => n.as_u64().unwrap_or(0) as u8,
            serde_json::Value::String(s) => s.parse().unwrap_or(0),
            _ => 0,
        };
        let block_number = match &self.block_number {
            serde_json::Value::Number(n) => n.as_u64().unwrap_or(0),
            serde_json::Value::String(s) => s.parse().unwrap_or(0),
            _ => 0,
        };
        GameRecorded {
            player: self.player,
            game_id,
            won,
            guesses,
            block_number,
        }
    }
}

/// Execute a Dune query and poll until results are available.
pub async fn fetch_game_recorded_events(
    api_key: &str,
    query_id: &str,
) -> Result<Vec<GameRecorded>, String> {
    let client = reqwest::Client::new();

    // Start execution
    let exec_url = format!("{DUNE_API_BASE}/query/{query_id}/execute");
    let exec_resp = client
        .post(&exec_url)
        .header("X-DUNE-API-KEY", api_key)
        .header("Content-Type", "application/json")
        .body("{}")
        .send()
        .await
        .map_err(|e| format!("Failed to start Dune execution: {e}"))?;

    if !exec_resp.status().is_success() {
        let status = exec_resp.status();
        let body = exec_resp.text().await.unwrap_or_default();
        return Err(format!(
            "Dune execute returned {status}: {body}"
        ));
    }

    let exec: ExecuteResponse = exec_resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse execution response: {e}"))?;

    println!("Dune execution started: {}", exec.execution_id);

    // Poll for results
    let results_url = format!(
        "{DUNE_API_BASE}/execution/{}/results",
        exec.execution_id
    );

    loop {
        tokio::time::sleep(Duration::from_secs(2)).await;

        let resp = client
            .get(&results_url)
            .header("X-DUNE-API-KEY", api_key)
            .send()
            .await
            .map_err(|e| format!("Failed to poll Dune results: {e}"))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "Dune results returned {status}: {body}"
            ));
        }

        let results: ResultsResponse = resp
            .json()
            .await
            .map_err(|e| format!("Failed to parse results response: {e}"))?;

        match results.state.as_str() {
            "QUERY_STATE_COMPLETED" => {
                let rows = results
                    .result
                    .map(|r| r.rows)
                    .unwrap_or_default();
                println!("Dune query completed with {} rows", rows.len());
                return Ok(rows.into_iter().map(|r| r.into_game_recorded()).collect());
            }
            "QUERY_STATE_FAILED" | "QUERY_STATE_CANCELLED" | "QUERY_STATE_EXPIRED" => {
                return Err(format!(
                    "Dune query ended with state: {}",
                    results.state
                ));
            }
            state => {
                println!("Dune query state: {state}, polling...");
            }
        }
    }
}
