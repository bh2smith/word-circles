// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

interface IERC20Lift {
    function erc20Circles(uint8 circlesType, address avatar) external view returns (address);
}

interface ICirclesToken {
    function avatar() external view returns (address);
}

contract WordCirclesEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 private constant CIRCLES_TYPE_INFLATION = 1;

    IERC20Lift public immutable erc20Lift;

    constructor(address _erc20Lift) {
        erc20Lift = IERC20Lift(_erc20Lift);
    }

    struct Game {
        uint128 players;
        uint128 capacity;
        address resolver;
        address creator;
        uint256 amount;
        address token;
        bool settled;
    }

    mapping(bytes32 => Game) public games;
    mapping(bytes32 => bool) public joined;
    mapping(bytes32 => uint256) public lobby;

    event Created(bytes32 gameId, address player, address resolver, address token, uint256 amount, uint128 capacity);
    event Joined(bytes32 gameId, address creator, address player, uint128 players);
    event Resolved(bytes32 gameId, address[] winners, uint256[] amounts);

    error AlreadySettled();
    error InvalidCapacity();
    error InvalidPayouts();
    error InvalidResolver();
    error InvalidSignature();
    error InvalidToken();
    error InvalidWinner();
    error NotStarted();
    error PlayerAlreadyJoined();

    function join(address resolver, address token, uint256 amount, uint128 capacity)
        external
        nonReentrant
        returns (bytes32)
    {
        if (capacity < 2) revert InvalidCapacity();
        if (resolver == address(0)) revert InvalidResolver();

        address avatar = ICirclesToken(token).avatar();
        if (erc20Lift.erc20Circles(CIRCLES_TYPE_INFLATION, avatar) != token) revert InvalidToken();

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);

        bytes32 lobbyKey = _lobbyKey(resolver, token, amount, capacity);
        uint256 count = lobby[lobbyKey];
        bytes32 gameId = keccak256(abi.encode(lobbyKey, count / capacity));

        Game storage game = games[gameId];

        bytes32 playerKey = keccak256(abi.encode(gameId, msg.sender));
        if (joined[playerKey]) revert PlayerAlreadyJoined();
        joined[playerKey] = true;

        if (game.players == 0) {
            game.capacity = capacity;
            game.resolver = resolver;
            game.creator = msg.sender;
            game.amount = amount;
            game.token = token;
            emit Created(gameId, msg.sender, resolver, token, amount, capacity);
        }

        game.players++;
        lobby[lobbyKey] = count + 1;

        emit Joined(gameId, game.creator, msg.sender, game.players);
        return gameId;
    }

    function resolve(bytes32 gameId, address[] calldata winners, uint256[] calldata amounts, bytes calldata signature)
        external
        nonReentrant
    {
        Game storage game = games[gameId];
        if (game.settled) revert AlreadySettled();
        if (game.players < game.capacity) revert NotStarted();
        if (winners.length != amounts.length) revert InvalidPayouts();

        bytes32 hash = keccak256(abi.encode(gameId, winners, amounts));
        bytes32 ethHash = MessageHashUtils.toEthSignedMessageHash(hash);
        address signer = ECDSA.recover(ethHash, signature);
        if (signer != game.resolver) revert InvalidSignature();

        uint256 totalPayout;
        for (uint256 i; i < amounts.length; i++) {
            totalPayout += amounts[i];
        }
        uint256 pot = game.amount * game.capacity;
        if (totalPayout > pot) revert InvalidPayouts();

        game.settled = true;

        for (uint256 i; i < winners.length; i++) {
            if (!isPlayerInGame(gameId, winners[i])) revert InvalidWinner();
            IERC20(game.token).safeTransfer(winners[i], amounts[i]);
        }

        uint256 remainder = pot - totalPayout;
        if (remainder > 0) {
            IERC20(game.token).safeTransfer(game.resolver, remainder);
        }

        emit Resolved(gameId, winners, amounts);
    }

    function isPlayerInGame(bytes32 gameId, address player) public view returns (bool) {
        return joined[keccak256(abi.encode(gameId, player))];
    }

    function getPlayerCount(address resolver, address token, uint256 amount, uint128 capacity)
        external
        view
        returns (uint128)
    {
        bytes32 lobbyKey = _lobbyKey(resolver, token, amount, capacity);
        return uint128(lobby[lobbyKey]);
    }

    function _lobbyKey(address resolver, address token, uint256 amount, uint128 capacity)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(resolver, token, amount, capacity));
    }
}
