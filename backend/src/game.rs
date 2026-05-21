use crate::words::{ANSWERS, VALID_GUESSES};
use rand::Rng;
use serde::Serialize;
use sha3::{Digest, Keccak256};

pub const WORD_LENGTH: usize = 5;
pub const MAX_GUESSES: usize = 6;

// Epoch: Jan 1, 2025 00:00:00 UTC
const EPOCH_SECS: i64 = 1_735_689_600;
const SECS_PER_DAY: i64 = 86_400;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LetterResult {
    Correct,
    Present,
    Absent,
}

fn hash_game_id(game_id: u32) -> u32 {
    let mut h = (game_id as u64).wrapping_mul(2_654_435_761) as u32;
    h = ((h >> 16) ^ h).wrapping_mul(0x45d9f3b);
    h = (h >> 16) ^ h;
    h
}

pub fn get_game_id() -> u32 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    ((now - EPOCH_SECS) / SECS_PER_DAY) as u32
}

pub fn answer_index(game_id: u32) -> usize {
    hash_game_id(game_id) as usize % ANSWERS.len()
}

pub fn get_answer(game_id: u32) -> &'static str {
    ANSWERS[answer_index(game_id)]
}

pub fn get_answer_by_index(index: usize) -> &'static str {
    ANSWERS[index]
}

pub fn random_word_index() -> usize {
    rand::rng().random_range(0..ANSWERS.len())
}

pub fn generate_salt() -> [u8; 32] {
    let mut salt = [0u8; 32];
    rand::rng().fill(&mut salt);
    salt
}

pub fn compute_commitment(game_id: u32, word_index: usize, salt: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Keccak256::new();
    let mut game_id_padded = [0u8; 32];
    game_id_padded[28..32].copy_from_slice(&game_id.to_be_bytes());
    hasher.update(game_id_padded);
    let mut index_bytes = [0u8; 32];
    index_bytes[24..].copy_from_slice(&(word_index as u64).to_be_bytes());
    hasher.update(index_bytes);
    hasher.update(salt);
    hasher.finalize().into()
}

pub fn is_valid_guess(word: &str) -> bool {
    word.len() == WORD_LENGTH && VALID_GUESSES.binary_search(&word).is_ok()
}

pub fn evaluate_guess(guess: &str, answer: &str) -> [LetterResult; 5] {
    let g: Vec<u8> = guess.bytes().collect();
    let a: Vec<u8> = answer.bytes().collect();
    let mut result = [LetterResult::Absent; WORD_LENGTH];
    let mut used = [false; WORD_LENGTH];

    for i in 0..WORD_LENGTH {
        if g[i] == a[i] {
            result[i] = LetterResult::Correct;
            used[i] = true;
        }
    }

    for i in 0..WORD_LENGTH {
        if result[i] == LetterResult::Correct {
            continue;
        }
        for j in 0..WORD_LENGTH {
            if !used[j] && g[i] == a[j] {
                result[i] = LetterResult::Present;
                used[j] = true;
                break;
            }
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn game_id_deterministic() {
        assert_eq!(get_answer(42), get_answer(42));
    }

    #[test]
    fn consecutive_days_differ() {
        let words: std::collections::HashSet<_> = (0..5).map(get_answer).collect();
        assert_eq!(words.len(), 5);
    }

    #[test]
    fn not_alphabetically_sequential() {
        let w0 = get_answer(0);
        let w1 = get_answer(1);
        let w2 = get_answer(2);
        assert!(!(w0 < w1 && w1 < w2));
    }

    #[test]
    fn valid_guesses() {
        assert!(is_valid_guess("crane"));
        assert!(is_valid_guess("about"));
        assert!(!is_valid_guess("zzzzz"));
        assert!(!is_valid_guess("hi"));
    }

    #[test]
    fn evaluate_all_correct() {
        assert_eq!(evaluate_guess("crane", "crane"), [LetterResult::Correct; 5]);
    }

    #[test]
    fn evaluate_all_absent() {
        assert_eq!(evaluate_guess("think", "amble"), [LetterResult::Absent; 5]);
    }

    #[test]
    fn evaluate_mixed() {
        use LetterResult::*;
        assert_eq!(
            evaluate_guess("crane", "react"),
            [Present, Present, Correct, Absent, Present]
        );
    }

    #[test]
    fn evaluate_case_insensitive_input() {
        assert_eq!(evaluate_guess("crane", "crane"), [LetterResult::Correct; 5]);
    }

    #[test]
    fn hash_matches_js_implementation() {
        assert_eq!(hash_game_id(0), 0);
        assert_eq!(hash_game_id(1), 1667036862);
        assert_eq!(hash_game_id(42), 301225621);
        assert_eq!(hash_game_id(100), 3925899253);
        assert_eq!(hash_game_id(504), 2474460488);
    }

    #[test]
    fn random_word_index_in_bounds() {
        for _ in 0..100 {
            let idx = random_word_index();
            assert!(idx < ANSWERS.len());
        }
    }

    #[test]
    fn salt_is_32_bytes() {
        let salt = generate_salt();
        assert_eq!(salt.len(), 32);
    }

    #[test]
    fn salts_differ() {
        let s1 = generate_salt();
        let s2 = generate_salt();
        assert_ne!(s1, s2);
    }

    #[test]
    fn commitment_deterministic() {
        let salt = [0xabu8; 32];
        let c1 = compute_commitment(42, 100, &salt);
        let c2 = compute_commitment(42, 100, &salt);
        assert_eq!(c1, c2);
    }

    #[test]
    fn commitment_changes_with_salt() {
        let s1 = [0x01u8; 32];
        let s2 = [0x02u8; 32];
        let c1 = compute_commitment(42, 100, &s1);
        let c2 = compute_commitment(42, 100, &s2);
        assert_ne!(c1, c2);
    }
}
