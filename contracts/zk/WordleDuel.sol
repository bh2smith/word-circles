// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IWordleVerifier} from "./IWordleVerifier.sol";

interface IERC20Lift {
    function erc20Circles(uint8 circlesType, address avatar) external view returns (address);
}

interface ICirclesToken {
    function avatar() external view returns (address);
}

/// @title  WordleDuel — trustless, chain-only ZK Wordle duel (M1)
/// @notice Two players each commit a secret answer word, then guess each
///         other's. The word-owner answers each incoming guess with a ZK proof
///         (verified on-chain via `IWordleVerifier`), so the contract — not a
///         trusted backend — is the referee. See docs/zk-duel-protocol.md.
///
///         Two independent tracks: trackA = A guessing B's word (answered by B
///         against commitmentB); trackB = B guessing A's word (answered by A
///         against commitmentA). Win by solving the opponent's word in the
///         fewest guesses; a word-owner who won't answer forfeits the pot; if
///         nobody solves, stakes are refunded. Pull payments via `withdraw()`.
///
///         This is M1: logic + escrow + timeouts + settlement, exercised against
///         a mock verifier. The real circuit binds the proof to `matchId` (M2)
///         and `HonkVerifier` is wired in for real proofs (M3).
contract WordleDuel is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 private constant CIRCLES_TYPE_INFLATION = 1;

    // Wordle params. feedback is packed base-4 (5 tiles, LSB-first;
    // absent=0, present=1, correct=2). All-correct = 2*(1+4+16+64+256) = 682.
    uint8 public constant MAX_GUESSES = 6;
    uint16 public constant FEEDBACK_SOLVED = 682;

    uint64 public constant JOIN_WINDOW = 1 hours;
    uint64 public constant MOVE_TIMEOUT = 24 hours;

    // bn254 scalar field is ~2^254; mask matchId to 253 bits so it is always a
    // valid field element usable directly as the circuit's match-binding input.
    uint256 private constant FIELD_MASK = (uint256(1) << 253) - 1;

    /// @notice The single Circles group ERC20 (inflation type) all duels stake.
    IERC20 public immutable token;
    IWordleVerifier public immutable verifier;
    /// @dev Poseidon Merkle root of the ANSWERS list (analog of WordCommitment's
    ///      wordListHash). Immutable so no caller can supply a degenerate root.
    bytes32 public immutable DICT_ROOT;

    enum Status {
        None,
        Open,
        Active,
        Settled,
        Cancelled
    }

    /// @dev One side of the duel, indexed by GUESSER. `greens`/`oranges` are
    ///      cumulative tallies for the tiebreak. `deadline` is the current
    ///      actor's clock: the owner's (answer the pending guess) when
    ///      `pendingGuess`, else the guesser's (make the next guess).
    struct Track {
        uint8 guessCount;
        uint8 greens;
        uint8 oranges;
        uint8 solvedAtGuess;
        bool solved;
        bool pendingGuess;
        uint64 deadline;
        uint8[5] guess; // current pending plaintext guess (valid iff pendingGuess)
    }

    struct Match {
        address playerA;
        address playerB;
        uint256 stake; // per player; pot = 2 * stake
        bytes32 commitmentA; // A's word; B guesses it on trackB
        bytes32 commitmentB; // B's word; A guesses it on trackA
        uint64 createDeadline;
        Status status;
        Track trackA; // A is guesser → answered against commitmentB (by B)
        Track trackB; // B is guesser → answered against commitmentA (by A)
    }

    mapping(bytes32 => Match) public matches;
    /// @notice Pull-payment balances credited at settlement; claim via withdraw().
    mapping(address => uint256) public withdrawable;

    event MatchCreated(bytes32 indexed matchId, address indexed playerA, uint256 stake, bytes32 commitmentA);
    event MatchJoined(bytes32 indexed matchId, address indexed playerB, bytes32 commitmentB);
    event MatchCancelled(bytes32 indexed matchId);
    event GuessSubmitted(bytes32 indexed matchId, address indexed guesser, uint8 guessNumber, uint8[5] guess);
    event FeedbackSubmitted(bytes32 indexed matchId, address indexed owner, uint8 guessNumber, uint16 feedback);
    event MatchSettled(bytes32 indexed matchId, address winner, uint256 amountA, uint256 amountB);
    event Withdrawn(address indexed player, uint256 amount);

    error AlreadyJoined();
    error GameOngoing();
    error GuessLimitReached();
    error GuessPending();
    error InvalidLetter();
    error InvalidProof();
    error InvalidStake();
    error InvalidToken();
    error JoinWindowOpen();
    error MatchExists();
    error NoGuessPending();
    error NothingToWithdraw();
    error NotActive();
    error NotOpen();
    error NotPlayer();
    error SelfPlay();
    error TurnExpired();

    constructor(address _erc20Lift, address _verifier, bytes32 _dictRoot, address _token) {
        // Validate the staking token is a Circles inflation ERC20 (same check the
        // existing escrow does per-join), once, at deploy.
        address avatar = ICirclesToken(_token).avatar();
        if (IERC20Lift(_erc20Lift).erc20Circles(CIRCLES_TYPE_INFLATION, avatar) != _token) revert InvalidToken();

        token = IERC20(_token);
        verifier = IWordleVerifier(_verifier);
        DICT_ROOT = _dictRoot;
    }

    // --- Match lifecycle ---------------------------------------------------

    /// @notice Create a match: escrow A's stake and commit A's secret word.
    /// @param nonce Caller-chosen value; `matchId` is derived from (sender, nonce)
    ///        so the creator can compute it locally and bind their commitment to
    ///        it before calling. Must be unused.
    /// @param commitmentA Poseidon2(secretA, saltA, matchId) — bound to this match.
    function createMatch(uint256 nonce, bytes32 commitmentA, uint256 stake)
        external
        nonReentrant
        returns (bytes32 matchId)
    {
        if (stake == 0) revert InvalidStake();

        matchId = _matchId(msg.sender, nonce);
        Match storage m = matches[matchId];
        if (m.status != Status.None) revert MatchExists();

        m.playerA = msg.sender;
        m.stake = stake;
        m.commitmentA = commitmentA;
        m.createDeadline = uint64(block.timestamp) + JOIN_WINDOW;
        m.status = Status.Open;

        token.safeTransferFrom(msg.sender, address(this), stake);
        emit MatchCreated(matchId, msg.sender, stake, commitmentA);
    }

    /// @notice Join an open match: escrow B's stake and commit B's word.
    /// @param commitmentB Poseidon2(secretB, saltB, matchId).
    function joinMatch(bytes32 matchId, bytes32 commitmentB) external nonReentrant {
        Match storage m = matches[matchId];
        if (m.status != Status.Open) revert NotOpen();
        if (msg.sender == m.playerA) revert SelfPlay();
        if (m.playerB != address(0)) revert AlreadyJoined();

        m.playerB = msg.sender;
        m.commitmentB = commitmentB;
        m.status = Status.Active;

        // Both guessers' first-move clocks start now.
        uint64 dl = uint64(block.timestamp) + MOVE_TIMEOUT;
        m.trackA.deadline = dl;
        m.trackB.deadline = dl;

        token.safeTransferFrom(msg.sender, address(this), m.stake);
        emit MatchJoined(matchId, msg.sender, commitmentB);
    }

    /// @notice Creator reclaims their stake if no opponent joined before the window.
    function cancelMatch(bytes32 matchId) external nonReentrant {
        Match storage m = matches[matchId];
        if (m.status != Status.Open) revert NotOpen();
        if (msg.sender != m.playerA) revert NotPlayer();
        if (block.timestamp <= m.createDeadline) revert JoinWindowOpen();

        m.status = Status.Cancelled;
        token.safeTransfer(m.playerA, m.stake);
        emit MatchCancelled(matchId);
    }

    // --- Gameplay ----------------------------------------------------------

    /// @notice Guesser posts a plaintext guess of the opponent's word.
    function submitGuess(bytes32 matchId, uint8[5] calldata guess) external {
        Match storage m = matches[matchId];
        if (m.status != Status.Active) revert NotActive();
        Track storage t = _guessTrack(m, msg.sender);

        if (t.pendingGuess) revert GuessPending();
        if (t.solved || t.guessCount >= MAX_GUESSES) revert GuessLimitReached();
        if (block.timestamp > t.deadline) revert TurnExpired();

        for (uint256 i; i < 5; i++) {
            if (guess[i] >= 26) revert InvalidLetter();
            t.guess[i] = guess[i];
        }
        t.pendingGuess = true;
        t.guessCount += 1;
        t.deadline = uint64(block.timestamp) + MOVE_TIMEOUT;

        emit GuessSubmitted(matchId, msg.sender, t.guessCount, guess);
    }

    /// @notice Word-owner answers the opponent's pending guess with a ZK proof
    ///         of the correct Wordle feedback against their committed word.
    /// @param feedback The packed base-4 feedback the proof attests to.
    /// @param proof    The UltraHonk proof bytes.
    function submitFeedback(bytes32 matchId, uint16 feedback, bytes calldata proof) external {
        Match storage m = matches[matchId];
        if (m.status != Status.Active) revert NotActive();

        // The caller answers the track where they are the OWNER (opponent guesses
        // the caller's word). commitment = the caller's own commitment.
        (Track storage t, bytes32 commitment) = _answerTrack(m, msg.sender);
        if (!t.pendingGuess) revert NoGuessPending();
        if (block.timestamp > t.deadline) revert TurnExpired(); // owner forfeited; resolve via settle

        // Public inputs (must match the M2 circuit signature order):
        // [commitment, dictionary_root, match_binding(=matchId), guess0..4, feedback].
        bytes32[] memory pi = new bytes32[](9);
        pi[0] = commitment;
        pi[1] = DICT_ROOT;
        pi[2] = matchId;
        for (uint256 i; i < 5; i++) {
            pi[3 + i] = bytes32(uint256(t.guess[i]));
        }
        pi[8] = bytes32(uint256(feedback));
        if (!verifier.verify(proof, pi)) revert InvalidProof();

        // Tally tiles for the tiebreak (2=correct/green, 1=present/orange).
        for (uint256 i; i < 5; i++) {
            uint256 tile = (uint256(feedback) >> (2 * i)) & 3;
            if (tile == 2) t.greens += 1;
            else if (tile == 1) t.oranges += 1;
        }
        if (feedback == FEEDBACK_SOLVED) {
            t.solved = true;
            t.solvedAtGuess = t.guessCount;
        }
        t.pendingGuess = false;
        // Hand the clock back to the guesser for their next move (if any remain).
        if (!t.solved && t.guessCount < MAX_GUESSES) {
            t.deadline = uint64(block.timestamp) + MOVE_TIMEOUT;
        }

        emit FeedbackSubmitted(matchId, msg.sender, t.guessCount, feedback);
    }

    // --- Settlement --------------------------------------------------------

    /// @notice Resolve a match once terminal (both tracks done, or a forfeit/
    ///         mutual timeout). Permissionless. Credits pull-payment balances.
    function settle(bytes32 matchId) external nonReentrant {
        Match storage m = matches[matchId];
        if (m.status != Status.Active) revert NotActive();

        uint256 pot = m.stake * 2;
        (address winner, uint256 amountA, uint256 amountB) = _outcome(m);
        assert(amountA + amountB == pot);

        m.status = Status.Settled;
        if (amountA > 0) withdrawable[m.playerA] += amountA;
        if (amountB > 0) withdrawable[m.playerB] += amountB;

        emit MatchSettled(matchId, winner, amountA, amountB);
    }

    /// @notice Claim accumulated winnings/refunds across all settled matches.
    function withdraw() external nonReentrant {
        uint256 amount = withdrawable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        withdrawable[msg.sender] = 0;
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // --- Outcome computation ----------------------------------------------

    /// @dev Returns (winner, amountA, amountB). winner == address(0) on a draw
    ///      (each reclaims their stake). Reverts if the match is not terminal.
    function _outcome(Match storage m) internal view returns (address winner, uint256 amountA, uint256 amountB) {
        uint256 pot = m.stake * 2;

        bool ownerForfeitA = m.trackA.pendingGuess && block.timestamp > m.trackA.deadline; // B failed to answer A
        bool ownerForfeitB = m.trackB.pendingGuess && block.timestamp > m.trackB.deadline; // A failed to answer B

        if (ownerForfeitA && ownerForfeitB) {
            return (address(0), m.stake, m.stake); // both owners stalled → refund
        }
        if (ownerForfeitA) return (m.playerA, pot, 0); // A's guess unanswered → A wins
        if (ownerForfeitB) return (m.playerB, 0, pot); // B's guess unanswered → B wins

        if (!_trackDone(m.trackA) || !_trackDone(m.trackB)) revert GameOngoing();

        bool aSolved = m.trackA.solved;
        bool bSolved = m.trackB.solved;

        if (aSolved && bSolved) {
            if (m.trackA.solvedAtGuess < m.trackB.solvedAtGuess) return (m.playerA, pot, 0);
            if (m.trackB.solvedAtGuess < m.trackA.solvedAtGuess) return (m.playerB, 0, pot);
            return _tiebreak(m); // same guess count → greens/oranges, else split
        }
        if (aSolved) return (m.playerA, pot, 0);
        if (bSolved) return (m.playerB, 0, pot);
        return (address(0), m.stake, m.stake); // neither solved → refund each
    }

    /// @dev A track is done when solved, guesses exhausted, or the guesser let
    ///      their move clock lapse (frozen — no penalty). NOT done while a guess
    ///      is pending (that's the owner's clock; handled as forfeit upstream).
    function _trackDone(Track storage t) internal view returns (bool) {
        if (t.solved || t.guessCount >= MAX_GUESSES) return true;
        return !t.pendingGuess && block.timestamp > t.deadline;
    }

    function _tiebreak(Match storage m) internal view returns (address, uint256, uint256) {
        uint256 pot = m.stake * 2;
        if (m.trackA.greens != m.trackB.greens) {
            return m.trackA.greens > m.trackB.greens ? (m.playerA, pot, uint256(0)) : (m.playerB, uint256(0), pot);
        }
        if (m.trackA.oranges != m.trackB.oranges) {
            return m.trackA.oranges > m.trackB.oranges ? (m.playerA, pot, uint256(0)) : (m.playerB, uint256(0), pot);
        }
        return (address(0), m.stake, m.stake); // perfect tie → split (== refund)
    }

    // --- Internal helpers --------------------------------------------------

    function _matchId(address creator, uint256 nonce) internal pure returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode(creator, nonce))) & FIELD_MASK);
    }

    /// @dev The track where `player` is the GUESSER.
    function _guessTrack(Match storage m, address player) internal view returns (Track storage) {
        if (player == m.playerA) return m.trackA;
        if (player == m.playerB) return m.trackB;
        revert NotPlayer();
    }

    /// @dev The track where `player` is the OWNER (answers the opponent), plus
    ///      the commitment to prove against (the owner's own committed word).
    function _answerTrack(Match storage m, address player) internal view returns (Track storage, bytes32) {
        if (player == m.playerA) return (m.trackB, m.commitmentA); // B guesses A's word
        if (player == m.playerB) return (m.trackA, m.commitmentB); // A guesses B's word
        revert NotPlayer();
    }

    // --- Views -------------------------------------------------------------

    function getMatch(bytes32 matchId)
        external
        view
        returns (
            address playerA,
            address playerB,
            uint256 stake,
            bytes32 commitmentA,
            bytes32 commitmentB,
            uint64 createDeadline,
            Status status
        )
    {
        Match storage m = matches[matchId];
        return (m.playerA, m.playerB, m.stake, m.commitmentA, m.commitmentB, m.createDeadline, m.status);
    }

    function getTrack(bytes32 matchId, bool isTrackA)
        external
        view
        returns (
            uint8 guessCount,
            uint8 greens,
            uint8 oranges,
            uint8 solvedAtGuess,
            bool solved,
            bool pendingGuess,
            uint64 deadline,
            uint8[5] memory guess
        )
    {
        Track storage t = isTrackA ? matches[matchId].trackA : matches[matchId].trackB;
        return (t.guessCount, t.greens, t.oranges, t.solvedAtGuess, t.solved, t.pendingGuess, t.deadline, t.guess);
    }
}
