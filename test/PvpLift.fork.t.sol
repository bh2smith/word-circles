// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../contracts/WordCirclesEscrow.sol";

// Fork test for issue #97: a player holding only personal CRC can enter PvP by
// "lifting" it into the group's static ERC20 stake token (s-gCRC) in the same
// batch as approve + join. The batch the frontend builds is:
//   1. Hub.groupMint(group, [player], [demurragedAmount], 0x)
//   2. Hub.wrap(group, demurragedAmount, 1)            -> mints s-gCRC to player
//   3. s-gCRC.approve(escrow, stake)
//   4. escrow.join(resolver, s-gCRC, stake, capacity)
//
// All addresses below are live Gnosis mainnet contracts, verified on-chain
// 2026-05-30. Run with a Gnosis RPC:
//   forge test --match-path test/PvpLift.fork.t.sol --fork-url $RPC_URL -vv

interface ICirclesHubV2 {
    function groupMint(address group, address[] calldata collateral, uint256[] calldata amounts, bytes calldata data)
        external;
    function wrap(address avatar, uint256 amount, uint8 circlesType) external returns (address);
    function trust(address trustReceiver, uint96 expiry) external;
    function isTrusted(address truster, address trustee) external view returns (bool);
    function balanceOf(address account, uint256 id) external view returns (uint256);
    function isHuman(address avatar) external view returns (bool);
    function day(uint256 timestamp) external view returns (uint64);
}

interface IWrapper {
    function convertInflationaryToDemurrageValue(uint256 value, uint64 day) external view returns (uint256);
    function convertDemurrageToInflationaryValue(uint256 value, uint64 day) external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function avatar() external view returns (address);
}

contract PvpLiftForkTest is Test {
    // --- Live Gnosis addresses (verified 2026-05-30) ---
    address constant HUB = 0xc12C1E50ABB450d6205Ea2C3Fa861b3B834d13e8;
    address constant ERC20_LIFT = 0x5F99a795dD2743C36D63511f0D4bc667e6d3cDB5;
    address constant GROUP = 0xC19BC204eb1c1D5B3FE500E5E5dfaBaB625F286c;
    address constant SGCRC = 0xeeF7B1f06B092625228C835Dd5D5B14641D1e54A; // s-gCRC == PVP_TOKEN
    // A real personal-CRC holder (minted s-gCRC in the past, so it's a registered human).
    address constant PLAYER = 0x0902c5866FBf7B30A4A2E26D37a97097eefe8243;

    uint8 constant CIRCLES_TYPE_INFLATION = 1;
    uint96 constant INDEFINITE = type(uint96).max;

    // Mirrors src/lib/contract.ts staticToDemurrage: both conversions floor, so a
    // naive round-trip can land 1 wei short. Bump the demurraged amount until
    // wrapping it back covers the static stake.
    function _staticToDemurrage(uint256 staticAmount, uint64 day) internal view returns (uint256 demurraged) {
        demurraged = IWrapper(SGCRC).convertInflationaryToDemurrageValue(staticAmount, day);
        for (uint256 i; i < 4; i++) {
            uint256 roundTrip = IWrapper(SGCRC).convertDemurrageToInflationaryValue(demurraged, day);
            if (roundTrip >= staticAmount) break;
            demurraged += staticAmount - roundTrip;
        }
    }

    WordCirclesEscrow escrow;
    address resolver = vm.addr(0xA11CE);
    uint256 stake = 1e15; // small static s-gCRC stake
    uint128 capacity = 2;

    function setUp() public {
        // Skip the whole suite unless a fork is active (no RPC in plain `forge test`).
        if (block.chainid != 100) {
            return;
        }
        // Reuse the production lift registry so the escrow's token validation
        // (erc20Lift.erc20Circles(1, avatar) == token) passes against real state.
        escrow = new WordCirclesEscrow(ERC20_LIFT);
    }

    modifier onlyFork() {
        if (block.chainid != 100) {
            emit log("skipping: not a Gnosis fork (pass --fork-url $RPC_URL)");
            return;
        }
        _;
    }

    // The full happy path: lift personal CRC -> s-gCRC -> approve -> join, all as
    // a single actor in sequence, mirroring the batched frontend submission.
    function test_liftThenJoin() public onlyFork {
        // Ensure the group trusts the player so groupMint is permitted. On live
        // state this trust has lapsed; granting it here isolates the lift mechanics
        // from the group's (separately-tested) trust policy.
        vm.prank(GROUP);
        ICirclesHubV2(HUB).trust(PLAYER, INDEFINITE);
        assertTrue(ICirclesHubV2(HUB).isTrusted(GROUP, PLAYER), "group should trust player");

        // The stake is in static units; groupMint/wrap need demurraged units.
        uint64 today = ICirclesHubV2(HUB).day(block.timestamp);
        uint256 wrapAmount = _staticToDemurrage(stake, today);
        assertGt(wrapAmount, 0, "conversion produced zero");

        uint256 personal = ICirclesHubV2(HUB).balanceOf(PLAYER, uint256(uint160(PLAYER)));
        assertGe(personal, wrapAmount, "player lacks enough personal CRC for the test stake");

        uint256 sgcrcBefore = IWrapper(SGCRC).balanceOf(PLAYER);

        // --- the batch, executed as the player ---
        vm.startPrank(PLAYER);

        address[] memory collateral = new address[](1);
        collateral[0] = PLAYER;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = wrapAmount;
        ICirclesHubV2(HUB).groupMint(GROUP, collateral, amounts, "");

        ICirclesHubV2(HUB).wrap(GROUP, wrapAmount, CIRCLES_TYPE_INFLATION);

        uint256 minted = IWrapper(SGCRC).balanceOf(PLAYER) - sgcrcBefore;
        // Wrapping `wrapAmount` demurraged units must yield at least `stake` static.
        assertGe(minted, stake, "lift produced less than the stake");

        IWrapper(SGCRC).approve(address(escrow), stake);
        bytes32 gameId = escrow.join(resolver, SGCRC, stake, capacity);

        vm.stopPrank();

        // The escrow accepted the lifted tokens and created the game.
        (uint128 players,,,,, address tok,) = escrow.games(gameId);
        assertEq(players, 1, "join did not register the player");
        assertEq(tok, SGCRC, "game token mismatch");
        assertTrue(escrow.isPlayerInGame(gameId, PLAYER), "player not in game");
        assertEq(IWrapper(SGCRC).balanceOf(address(escrow)), stake, "escrow did not receive the stake");
    }

    // Negative: a fresh human the group does NOT trust cannot self-lift. This
    // locks in the prerequisite from the issue ("players as well" depends on the
    // group's trust policy) so a future trust change can't silently break it.
    function test_untrustedPlayerCannotGroupMint() public onlyFork {
        // PLAYER currently has personal CRC but the group's trust has lapsed.
        assertFalse(ICirclesHubV2(HUB).isTrusted(GROUP, PLAYER), "precondition: group must not trust player");

        uint64 today = ICirclesHubV2(HUB).day(block.timestamp);
        uint256 wrapAmount = _staticToDemurrage(stake, today);

        address[] memory collateral = new address[](1);
        collateral[0] = PLAYER;
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = wrapAmount;

        vm.prank(PLAYER);
        vm.expectRevert(); // group mint policy rejects untrusted collateral
        ICirclesHubV2(HUB).groupMint(GROUP, collateral, amounts, "");
    }
}
