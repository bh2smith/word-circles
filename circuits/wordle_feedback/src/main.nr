//! ZK Wordle-Duel feedback circuit (feasibility spike).
//!
//! Proves that a 5-tile Wordle `feedback` is the correct scoring of a public
//! `guess` against a *private* `secret` word — without revealing the secret.
//!
//! The statement (one direction, one guess):
//!   Public inputs:  commitment, guess[5]   Public output: feedback (packed)
//!   Private witness: secret[5], salt
//!   Proves: (1) poseidon2(secret..salt) == commitment   (binds the letters)
//!           (2) feedback == wordleScore(secret, guess)
//!
//! Encoding conventions (must stay in lock-step with the TS/Rust game + harness):
//!   - Letters `a..z` map to field/u8 values `0..25`.
//!   - Tiles: `absent = 0`, `present = 1`, `correct = 2`.
//!   - Feedback is packed base-4, least-significant tile first:
//!       packed = Σ tile_i * 4^i   (i = 0..4)
//!
//! The scoring is a bit-exact port of `evaluateGuess` in
//! `src/lib/game.server.ts` (mirrored in `backend/src/game.rs::evaluate_guess`):
//! a two-pass algorithm where pass 1 marks greens and consumes answer letters,
//! and pass 2 marks yellows from the *first remaining unused* answer letter,
//! scanning left-to-right (the `break` in the TS source).

use poseidon::poseidon2::Poseidon2;

global WORD_LENGTH: u32 = 5;

global ABSENT: u8 = 0;
global PRESENT: u8 = 1;
global CORRECT: u8 = 2;

fn main(secret: [u8; 5], salt: Field, commitment: pub Field, guess: pub [u8; 5]) -> pub Field {
    // (1) The commitment must open to the secret word + salt. This binds the
    // proven scoring to a value the player committed to earlier on-chain.
    assert(commit(secret, salt) == commitment, "commitment mismatch");
    // (2) Feedback is the correct Wordle scoring of `guess` against `secret`.
    score(secret, guess)
}

/// Poseidon2 commitment over the 5 letters + salt. SNARK-friendly (cheap
/// in-circuit) — this is a NEW commitment binding letters, distinct from and
/// coexisting with the existing keccak/wordIndex scheme in WordCommitment.sol.
fn commit(secret: [u8; 5], salt: Field) -> Field {
    let preimage: [Field; 6] = [
        secret[0] as Field,
        secret[1] as Field,
        secret[2] as Field,
        secret[3] as Field,
        secret[4] as Field,
        salt,
    ];
    Poseidon2::hash(preimage, 6)
}

/// Returns the packed base-4 feedback of `guess` scored against `secret`.
fn score(secret: [u8; 5], guess: [u8; 5]) -> Field {
    // Range-check inputs: every letter must be a valid a..z index.
    for i in 0..WORD_LENGTH {
        assert(secret[i] < 26, "secret letter out of range");
        assert(guess[i] < 26, "guess letter out of range");
    }

    let mut tiles: [u8; 5] = [ABSENT; 5];
    let mut answer_used: [bool; 5] = [false; 5];

    // Pass 1 — greens: exact-position matches consume the answer letter.
    for i in 0..WORD_LENGTH {
        if guess[i] == secret[i] {
            tiles[i] = CORRECT;
            answer_used[i] = true;
        }
    }

    // Pass 2 — yellows: for each non-green guess tile, mark PRESENT on the
    // first as-yet-unused answer letter that matches (left-to-right). The
    // `matched` flag emulates the TS `break` so each guess letter consumes at
    // most one answer letter.
    for i in 0..WORD_LENGTH {
        if tiles[i] != CORRECT {
            let mut matched = false;
            for j in 0..WORD_LENGTH {
                let hit = (!matched) & (!answer_used[j]) & (guess[i] == secret[j]);
                if hit {
                    tiles[i] = PRESENT;
                    answer_used[j] = true;
                    matched = true;
                }
            }
        }
    }

    // Pack base-4, least-significant tile first.
    let mut packed: Field = 0;
    let mut mult: Field = 1;
    for i in 0..WORD_LENGTH {
        packed += (tiles[i] as Field) * mult;
        mult *= 4;
    }
    packed
}

// ---------------------------------------------------------------------------
// Tests — vectors lifted verbatim from src/lib/game.test.ts so the circuit is
// pinned bit-exactly to the canonical scoring (incl. duplicate-letter cases).
// Letter encoding: a=0 b=1 c=2 d=3 e=4 f=5 g=6 ... n=13 ... r=17 s=18 t=19 ...
// ---------------------------------------------------------------------------

#[test]
fn test_all_correct() {
    // crane vs crane -> [C,C,C,C,C]; packed = 2*(1+4+16+64+256) = 682
    let crane = [2, 17, 0, 13, 4];
    assert(score(crane, crane) == 682);
}

#[test]
fn test_all_absent() {
    // guess think vs secret amble -> all absent -> 0
    let think = [19, 7, 8, 13, 10];
    let amble = [0, 12, 1, 11, 4];
    assert(score(amble, think) == 0);
}

#[test]
fn test_mixed() {
    // guess crane vs secret react -> [present,present,correct,absent,present]
    // tiles [1,1,2,0,1]; packed = 1 + 4 + 32 + 0 + 256 = 293
    let crane = [2, 17, 0, 13, 4];
    let react = [17, 4, 0, 2, 19];
    assert(score(react, crane) == 293);
}

#[test]
fn test_dup_one_correct_one_absent() {
    // guess speed vs secret abide -> [absent,absent,present,absent,present]
    // tiles [0,0,1,0,1]; packed = 16 + 256 = 272
    let speed = [18, 15, 4, 4, 3];
    let abide = [0, 1, 8, 3, 4];
    assert(score(abide, speed) == 272);
}

#[test]
fn test_dup_guess_letter_one_match() {
    // guess geese vs secret edges -> [present,present,present,present,absent]
    // tiles [1,1,1,1,0]; packed = 1 + 4 + 16 + 64 = 85
    let geese = [6, 4, 4, 18, 4];
    let edges = [4, 3, 6, 4, 18];
    assert(score(edges, geese) == 85);
}

// Full statement: a matching commitment passes and yields the right feedback.
#[test]
fn test_main_with_commitment() {
    let react = [17, 4, 0, 2, 19]; // secret
    let crane = [2, 17, 0, 13, 4]; // guess
    let salt: Field = 123456789;
    let commitment = commit(react, salt);
    assert(main(react, salt, commitment, crane) == 293);
}

// A wrong secret/salt must NOT open the commitment.
#[test(should_fail_with = "commitment mismatch")]
fn test_main_bad_commitment() {
    let react = [17, 4, 0, 2, 19];
    let crane = [2, 17, 0, 13, 4];
    let salt: Field = 123456789;
    let bad_commitment = commit(react, salt) + 1;
    let _ = main(react, salt, bad_commitment, crane);
}

// Helper: prints the Prover.toml `commitment` for the sample inputs.
// Run: `nargo test print_sample_commitment --show-output`
#[test]
fn print_sample_commitment() {
    let react = [17, 4, 0, 2, 19];
    let salt: Field = 123456789;
    println(commit(react, salt));
}
