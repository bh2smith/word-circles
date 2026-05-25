use duners::DuneClient;
use serde::Deserialize;

fn string_as_u32<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u32, D::Error> {
    let s = String::deserialize(d)?;
    s.parse().map_err(serde::de::Error::custom)
}

fn string_as_u8<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u8, D::Error> {
    let s = String::deserialize(d)?;
    s.parse().map_err(serde::de::Error::custom)
}

fn string_as_u64<'de, D: serde::Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    let s = String::deserialize(d)?;
    s.parse().map_err(serde::de::Error::custom)
}

#[derive(Debug, Clone, Deserialize)]
pub struct GameRecorded {
    pub player: String,
    #[serde(alias = "gameId", alias = "game_id", deserialize_with = "string_as_u32")]
    pub game_id: u32,
    pub won: bool,
    #[serde(deserialize_with = "string_as_u8")]
    pub guesses: u8,
    #[serde(deserialize_with = "string_as_u64")]
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
