use crate::words::{ANSWERS, VALID_GUESSES};
use serde::Serialize;

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

pub fn get_answer(game_id: u32) -> &'static str {
    let index = hash_game_id(game_id) as usize % ANSWERS.len();
    ANSWERS[index]
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
}
