// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice On-chain commitment scheme so players can verify the backend didn't
///         change the word after seeing guesses.
///
///         Flow:
///           1. Resolver calls commit(gameId, keccak256(abi.encode(gameId, wordIndex, salt)))
///              at or before game start.
///           2. After the game ends, resolver calls reveal(gameId, wordIndex, salt).
///           3. Anyone can call verify(gameId) to confirm the reveal matches the commitment.
///
///         Word list integrity:
///           wordListHash = keccak256(abi.encodePacked(word1, word2, ...)) over the ANSWERS
///           array (each word is exactly 5 ASCII bytes, concatenated in order).
///           wordListUri points to the canonical published copy of that list.
///           Together they let anyone verify that a revealed wordIndex maps to the
///           expected word without trusting the backend.
contract WordCommitment {
    struct Commitment {
        bytes32 hash;
        uint256 wordIndex;
        bytes32 salt;
        bool revealed;
    }

    address public immutable resolver;
    bytes32 public immutable wordListHash;
    string public wordListUri;

    mapping(bytes32 => Commitment) public commitments;

    event Committed(bytes32 indexed gameId, bytes32 commitmentHash);
    event Revealed(bytes32 indexed gameId, uint256 wordIndex, bytes32 salt);

    error AlreadyCommitted();
    error AlreadyRevealed();
    error InvalidReveal();
    error NotCommitted();
    error Unauthorized();

    constructor(address _resolver, bytes32 _wordListHash, string memory _wordListUri) {
        resolver = _resolver;
        wordListHash = _wordListHash;
        wordListUri = _wordListUri;
    }

    function commit(bytes32 gameId, bytes32 commitmentHash) external {
        if (msg.sender != resolver) revert Unauthorized();
        if (commitments[gameId].hash != bytes32(0)) revert AlreadyCommitted();

        commitments[gameId].hash = commitmentHash;
        emit Committed(gameId, commitmentHash);
    }

    function reveal(bytes32 gameId, uint256 wordIndex, bytes32 salt) external {
        if (msg.sender != resolver) revert Unauthorized();
        Commitment storage c = commitments[gameId];
        if (c.hash == bytes32(0)) revert NotCommitted();
        if (c.revealed) revert AlreadyRevealed();

        bytes32 expected = keccak256(abi.encode(gameId, wordIndex, salt));
        if (expected != c.hash) revert InvalidReveal();

        c.wordIndex = wordIndex;
        c.salt = salt;
        c.revealed = true;
        emit Revealed(gameId, wordIndex, salt);
    }

    function verify(bytes32 gameId) external view returns (bool) {
        Commitment storage c = commitments[gameId];
        if (!c.revealed) return false;
        return keccak256(abi.encode(gameId, c.wordIndex, c.salt)) == c.hash;
    }
}
