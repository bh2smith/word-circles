//! ZK Wordle-Duel feedback circuit (feasibility spike).
//!
//! Proves that a 5-tile Wordle `feedback` is the correct scoring of a public
//! `guess` against a *private* `secret` word — without revealing the secret.
//!
//! The statement (one direction, one guess):
//!   Public inputs:  commitment, dictionary_root, guess[5]   Public output: feedback (packed)
//!   Private witness: secret[5], salt, leaf_index, merkle_path[DEPTH]
//!   Proves: (1) poseidon2(secret..salt) == commitment        (binds the letters)
//!           (2) secret ∈ dictionary (Poseidon Merkle membership)
//!           (3) feedback == wordleScore(secret, guess)
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
global DEPTH: u32 = 12; // Merkle depth; 2^12 = 4096 >= 2315 answers

global ABSENT: u8 = 0;
global PRESENT: u8 = 1;
global CORRECT: u8 = 2;

fn main(
    secret: [u8; 5],
    salt: Field,
    leaf_index: u32,
    merkle_path: [Field; 12],
    commitment: pub Field,
    dictionary_root: pub Field,
    guess: pub [u8; 5],
) -> pub Field {
    // (1) The commitment must open to the secret word + salt. This binds the
    // proven scoring to a value the player committed to earlier on-chain.
    assert(commit(secret, salt) == commitment, "commitment mismatch");
    // (2) The secret must be a real answer word (membership in the dictionary
    // Merkle tree), so a player can't commit to a non-word.
    assert(
        in_dictionary(secret, leaf_index, merkle_path) == dictionary_root,
        "not in dictionary",
    );
    // (3) Feedback is the correct Wordle scoring of `guess` against `secret`.
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

/// Recompute the Merkle root from the secret's leaf and its sibling path.
/// leaf = poseidon2([l0..l4]); internal node = poseidon2([left, right]). The
/// caller asserts the result equals the public `dictionary_root`.
fn in_dictionary(secret: [u8; 5], leaf_index: u32, merkle_path: [Field; 12]) -> Field {
    let mut node = Poseidon2::hash(
        [
            secret[0] as Field,
            secret[1] as Field,
            secret[2] as Field,
            secret[3] as Field,
            secret[4] as Field,
        ],
        WORD_LENGTH,
    );
    for d in 0..DEPTH {
        let sibling = merkle_path[d];
        let bit = (leaf_index >> d) & 1;
        // bit == 0 -> leaf/node is the left child; else the right child.
        let left = if bit == 0 { node } else { sibling };
        let right = if bit == 0 { sibling } else { node };
        node = Poseidon2::hash([left, right], 2);
    }
    node
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
// Tests — scoring vectors lifted verbatim from src/lib/game.test.ts so the
// circuit is pinned bit-exactly to the canonical scoring (incl. duplicate
// letters). Membership vectors come from `bun run scripts/build-tree.ts react`.
// Letter encoding: a=0 b=1 c=2 d=3 e=4 f=5 g=6 ... n=13 ... r=17 s=18 t=19 ...
// ---------------------------------------------------------------------------

// Secret "react" and its membership proof in the ANSWERS Merkle tree.
global REACT: [u8; 5] = [17, 4, 0, 2, 19];
global REACT_SALT: Field = 123456789;
global REACT_INDEX: u32 = 1551;
global DICT_ROOT: Field = 0x0984b03ac65fe9e4710ce7fb30f53d292b0d03f812b247ef32764d6018655f87;
global REACT_PATH: [Field; 12] = [
    0x045bd9ed3ac414de0d5fac24eb9b9c7fbee04989a18709d7685ba8e5c5b936e0,
    0x19e04053a5d447fe2a0dfa778cd902dd355e2392b83b5fd7952b986d414ca7a0,
    0x2b78a6bcdc68cf0a3b5f3b607be96927d81d4109500cd54d1c0ab47b80d25f83,
    0x053ef0fdb4111cbf733469814de278e2c7816e905615bf3b639611cf4cf9d149,
    0x2a04b3a24e9af138064e1630c91e9481a09d10e719eb9760defd82aec29ecaf2,
    0x0506a795dd5d819a37eb05d0868e50f3f6a0253b771b9549b4ef3c5db15b13c3,
    0x1669a20353f0501600beee0d17dc87d56f13a6c8a634e7262bd831b7b27a5d35,
    0x1b20a170777fb18bc22dea8c05b453c2d19763097fe9d890cd120c6c75acb1b4,
    0x09edc957d5a2fd79a3924a1e4843314211dc3f1929f73f2dead2756a7cdfac50,
    0x020a825390af1ce1faf69ca0c853472ea5f5381c720c739907c93cf99e8f4d33,
    0x0f105f1934d2274e6b0309e9eb601c2b027883e8119b8a1e31fbe4593f92a8f8,
    0x19b6aa7756aef2920b328ec711d5f70387119a6c19dea97aea24b5b1a0f50286,
];

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
    assert(score(REACT, crane) == 293);
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

// Membership: the TS-built path for "react" recomputes the dictionary root.
#[test]
fn test_membership() {
    assert(in_dictionary(REACT, REACT_INDEX, REACT_PATH) == DICT_ROOT);
}

// A wrong index (sibling order flipped) must NOT reproduce the root.
#[test]
fn test_membership_bad_index() {
    assert(in_dictionary(REACT, REACT_INDEX + 1, REACT_PATH) != DICT_ROOT);
}

// Full statement: matching commitment + membership yields the right feedback.
#[test]
fn test_main_full() {
    let crane = [2, 17, 0, 13, 4]; // guess
    let commitment = commit(REACT, REACT_SALT);
    let fb = main(
        REACT,
        REACT_SALT,
        REACT_INDEX,
        REACT_PATH,
        commitment,
        DICT_ROOT,
        crane,
    );
    assert(fb == 293);
}

// A wrong secret/salt must NOT open the commitment.
#[test(should_fail_with = "commitment mismatch")]
fn test_main_bad_commitment() {
    let crane = [2, 17, 0, 13, 4];
    let bad_commitment = commit(REACT, REACT_SALT) + 1;
    let _ = main(
        REACT,
        REACT_SALT,
        REACT_INDEX,
        REACT_PATH,
        bad_commitment,
        DICT_ROOT,
        crane,
    );
}

// Helper: prints the Prover.toml `commitment` for the sample inputs.
// Run: `nargo test print_sample_commitment --show-output`
#[test]
fn print_sample_commitment() {
    println(commit(REACT, REACT_SALT));
}
