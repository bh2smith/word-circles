"use client";

import {
  type Address,
  type Hex,
  createPublicClient,
  getAddress,
  http,
} from "viem";
import { gnosis } from "viem/chains";
import {
  DICT_ROOT,
  deriveMatchId,
  encodeCancelMatch,
  encodeCreateMatch,
  encodeJoinMatch,
  encodeSettle,
  encodeSubmitGuess,
  encodeWithdraw,
  WORDLE_DUEL_ABI,
  lettersToWord,
  unpackFeedback,
  type Tile,
} from "@/lib/duel";

export const FRONTEND_ZK_DUEL_ENABLED =
  process.env.NEXT_PUBLIC_ZK_DUEL_ENABLED === "true";

export const ZK_DUEL_ADDRESS = normalizeOptionalAddress(
  process.env.NEXT_PUBLIC_ZK_DUEL_ADDRESS,
);

export const ZK_DUEL_TOKEN_ADDRESS = normalizeOptionalAddress(
  process.env.NEXT_PUBLIC_ZK_DUEL_TOKEN_ADDRESS,
);

export const DEFAULT_ZK_DUEL_STAKE = parseEnvBigInt(
  process.env.NEXT_PUBLIC_ZK_DUEL_DEFAULT_STAKE,
  0n,
);

export const ANSWERS_URL =
  process.env.NEXT_PUBLIC_ZK_DUEL_ANSWERS_URL ?? "/zk-duel-answers.json";

/**
 * Block the WordleDuel contract was deployed at, used as the floor for the
 * very first (cold) event scan when there is no persisted board to resume from.
 * Defaults to the M3 Gnosis deployment; override per-deployment via env.
 */
export const ZK_DUEL_DEPLOY_BLOCK = parseEnvBigInt(
  process.env.NEXT_PUBLIC_ZK_DUEL_DEPLOY_BLOCK,
  46624922n,
);

/** Max block span per getLogs request, to stay under public-RPC range caps. */
const LOG_CHUNK = 9000n;

const publicClient = createPublicClient({ chain: gnosis, transport: http() });

export type MatchStatus = "none" | "open" | "active" | "settled" | "cancelled";

const STATUS: MatchStatus[] = [
  "none",
  "open",
  "active",
  "settled",
  "cancelled",
];

export interface ZkTrackState {
  guessCount: number;
  greens: number;
  oranges: number;
  solvedAtGuess: number;
  solved: boolean;
  pendingGuess: boolean;
  deadline: bigint;
  guessLetters: readonly number[];
  guessWord: string;
}

export interface ZkMatchState {
  matchId: Hex;
  playerA: Address;
  playerB: Address;
  stake: bigint;
  commitmentA: Hex;
  commitmentB: Hex;
  createDeadline: bigint;
  status: MatchStatus;
  trackA: ZkTrackState;
  trackB: ZkTrackState;
  withdrawable: bigint;
  dictRoot: Hex;
  token: Address;
}

/**
 * One rendered board line: the plaintext guess plus its per-tile colors once
 * the word-owner has answered with a proof. `tiles === null` means the guess is
 * on-chain but still awaiting feedback (renders as an uncolored row).
 */
export interface ZkBoardRow {
  guessNumber: number;
  word: string;
  tiles: Tile[] | null;
}

/**
 * Both guess tracks reconstructed from GuessSubmitted/FeedbackSubmitted logs.
 * `lastScannedBlock` lets us resume incrementally instead of re-scanning from
 * the deploy block on every poll.
 */
export interface ZkBoards {
  trackA: ZkBoardRow[];
  trackB: ZkBoardRow[];
  lastScannedBlock: bigint;
}

export interface StoredZkDuelSecret {
  matchId: Hex;
  role: "creator" | "joiner";
  secret: string;
  salt: string;
  nonce?: string;
  stake?: string;
  createdAt: number;
}

export function zkDuelConfigured(): boolean {
  return Boolean(FRONTEND_ZK_DUEL_ENABLED && ZK_DUEL_ADDRESS);
}

export function newSalt(): bigint {
  return randomFieldElement();
}

export function newNonce(): bigint {
  return randomFieldElement();
}

export function matchBinding(matchId: Hex): bigint {
  return BigInt(matchId);
}

export function computeCreatorMatchId(creator: string, nonce: bigint): Hex {
  return deriveMatchId(getAddress(creator), nonce);
}

export async function readZkDuelToken(): Promise<Address> {
  if (ZK_DUEL_TOKEN_ADDRESS) return ZK_DUEL_TOKEN_ADDRESS;
  if (!ZK_DUEL_ADDRESS) throw new Error("ZK duel address is not configured");
  return publicClient.readContract({
    address: ZK_DUEL_ADDRESS,
    abi: WORDLE_DUEL_ABI,
    functionName: "token",
  });
}

export async function readZkMatch(
  matchId: Hex,
  player?: string | null,
): Promise<ZkMatchState> {
  if (!ZK_DUEL_ADDRESS) throw new Error("ZK duel address is not configured");
  const [match, trackA, trackB, token, dictRoot, withdrawable] =
    await Promise.all([
      publicClient.readContract({
        address: ZK_DUEL_ADDRESS,
        abi: WORDLE_DUEL_ABI,
        functionName: "getMatch",
        args: [matchId],
      }),
      publicClient.readContract({
        address: ZK_DUEL_ADDRESS,
        abi: WORDLE_DUEL_ABI,
        functionName: "getTrack",
        args: [matchId, true],
      }),
      publicClient.readContract({
        address: ZK_DUEL_ADDRESS,
        abi: WORDLE_DUEL_ABI,
        functionName: "getTrack",
        args: [matchId, false],
      }),
      readZkDuelToken(),
      publicClient.readContract({
        address: ZK_DUEL_ADDRESS,
        abi: WORDLE_DUEL_ABI,
        functionName: "DICT_ROOT",
      }),
      player
        ? publicClient.readContract({
            address: ZK_DUEL_ADDRESS,
            abi: WORDLE_DUEL_ABI,
            functionName: "withdrawable",
            args: [getAddress(player)],
          })
        : Promise.resolve(0n),
    ]);

  return {
    matchId,
    playerA: match[0],
    playerB: match[1],
    stake: match[2],
    commitmentA: match[3],
    commitmentB: match[4],
    createDeadline: match[5],
    status: STATUS[match[6]] ?? "none",
    trackA: normalizeTrack(trackA),
    trackB: normalizeTrack(trackB),
    token,
    dictRoot,
    withdrawable,
  };
}

export async function currentBlock(): Promise<bigint> {
  return publicClient.getBlockNumber();
}

/**
 * Reconstruct both colored boards from the duel's GuessSubmitted /
 * FeedbackSubmitted logs over RPC. Pass the previous result to scan only the
 * blocks since the last poll (cheap for a live game); pass `null` to cold-start
 * from the deploy block. `matchId` is an indexed topic, so each query returns
 * only this match's handful of logs.
 */
export async function scanZkBoards(
  matchId: Hex,
  state: Pick<ZkMatchState, "playerA" | "playerB">,
  prev: ZkBoards | null,
): Promise<ZkBoards> {
  if (!ZK_DUEL_ADDRESS) throw new Error("ZK duel address is not configured");
  const latest = await publicClient.getBlockNumber();
  const fromBlock = prev ? prev.lastScannedBlock + 1n : ZK_DUEL_DEPLOY_BLOCK;
  if (fromBlock > latest) {
    return prev ?? { trackA: [], trackB: [], lastScannedBlock: latest };
  }

  const a = state.playerA.toLowerCase();
  const b = state.playerB.toLowerCase();
  const trackA = new Map<number, ZkBoardRow>();
  const trackB = new Map<number, ZkBoardRow>();
  for (const row of prev?.trackA ?? []) trackA.set(row.guessNumber, { ...row });
  for (const row of prev?.trackB ?? []) trackB.set(row.guessNumber, { ...row });

  for (let start = fromBlock; start <= latest; start += LOG_CHUNK + 1n) {
    const end = start + LOG_CHUNK < latest ? start + LOG_CHUNK : latest;
    const [guesses, feedbacks] = await Promise.all([
      publicClient.getContractEvents({
        address: ZK_DUEL_ADDRESS,
        abi: WORDLE_DUEL_ABI,
        eventName: "GuessSubmitted",
        args: { matchId },
        fromBlock: start,
        toBlock: end,
      }),
      publicClient.getContractEvents({
        address: ZK_DUEL_ADDRESS,
        abi: WORDLE_DUEL_ABI,
        eventName: "FeedbackSubmitted",
        args: { matchId },
        fromBlock: start,
        toBlock: end,
      }),
    ]);

    for (const log of guesses) {
      const guesser = String(log.args.guesser).toLowerCase();
      // A guesses on trackA, B on trackB.
      const target = guesser === a ? trackA : guesser === b ? trackB : null;
      if (!target) continue;
      const n = Number(log.args.guessNumber);
      const word = lettersToWord([...(log.args.guess as readonly number[])]);
      target.set(n, {
        guessNumber: n,
        word,
        tiles: target.get(n)?.tiles ?? null,
      });
    }
    for (const log of feedbacks) {
      const owner = String(log.args.owner).toLowerCase();
      // The owner answers the OPPONENT's guesses: B answers trackA, A answers trackB.
      const target = owner === b ? trackA : owner === a ? trackB : null;
      if (!target) continue;
      const n = Number(log.args.guessNumber);
      const tiles = unpackFeedback(Number(log.args.feedback));
      target.set(n, { guessNumber: n, word: target.get(n)?.word ?? "", tiles });
    }
  }

  const sort = (m: Map<number, ZkBoardRow>) =>
    [...m.values()].sort((x, y) => x.guessNumber - y.guessNumber);
  return {
    trackA: sort(trackA),
    trackB: sort(trackB),
    lastScannedBlock: latest,
  };
}

function boardStorageKey(matchId: Hex): string {
  return `wordcircle-zk-duel:board:${matchId.toLowerCase()}`;
}

export function loadZkBoard(matchId: Hex): ZkBoards | null {
  try {
    const raw = localStorage.getItem(boardStorageKey(matchId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      trackA: ZkBoardRow[];
      trackB: ZkBoardRow[];
      lastScannedBlock: string;
    };
    return {
      trackA: parsed.trackA,
      trackB: parsed.trackB,
      lastScannedBlock: BigInt(parsed.lastScannedBlock),
    };
  } catch {
    return null;
  }
}

export function saveZkBoard(matchId: Hex, boards: ZkBoards) {
  try {
    localStorage.setItem(
      boardStorageKey(matchId),
      JSON.stringify({
        trackA: boards.trackA,
        trackB: boards.trackB,
        lastScannedBlock: boards.lastScannedBlock.toString(),
      }),
    );
  } catch {
    // best-effort; a full/blocked localStorage just means a cold rescan later
  }
}

export async function loadZkAnswers(): Promise<string[]> {
  const res = await fetch(ANSWERS_URL, { cache: "force-cache" });
  if (!res.ok) throw new Error(`failed to load answer list: ${res.status}`);
  const answers = (await res.json()) as unknown;
  if (!Array.isArray(answers) || !answers.every((w) => typeof w === "string")) {
    throw new Error("answer list has invalid shape");
  }
  return answers;
}

export function assertOnchainDictRoot(state: Pick<ZkMatchState, "dictRoot">) {
  if (state.dictRoot.toLowerCase() !== DICT_ROOT.toLowerCase()) {
    throw new Error(
      `ZK duel DICT_ROOT mismatch: frontend ${DICT_ROOT}, contract ${state.dictRoot}`,
    );
  }
}

export function secretStorageKey(matchId: Hex, player: string): string {
  return `wordcircle-zk-duel:${player.toLowerCase()}:${matchId.toLowerCase()}`;
}

export function saveZkDuelSecret(player: string, value: StoredZkDuelSecret) {
  localStorage.setItem(
    secretStorageKey(value.matchId, player),
    JSON.stringify(value),
  );
  localStorage.setItem("wordcircle-zk-duel:last", value.matchId);
}

export function loadZkDuelSecret(
  player: string,
  matchId: Hex,
): StoredZkDuelSecret | null {
  try {
    const raw = localStorage.getItem(secretStorageKey(matchId, player));
    return raw ? (JSON.parse(raw) as StoredZkDuelSecret) : null;
  } catch {
    return null;
  }
}

export function loadLastZkDuel(): Hex | null {
  const raw = localStorage.getItem("wordcircle-zk-duel:last");
  return raw && /^0x[0-9a-fA-F]{64}$/.test(raw) ? (raw as Hex) : null;
}

export function myGuessTrack(
  state: ZkMatchState,
  player: string,
): ZkTrackState | null {
  const p = player.toLowerCase();
  if (state.playerA.toLowerCase() === p) return state.trackA;
  if (state.playerB.toLowerCase() === p) return state.trackB;
  return null;
}

export function myAnswerTrack(
  state: ZkMatchState,
  player: string,
): ZkTrackState | null {
  const p = player.toLowerCase();
  if (state.playerA.toLowerCase() === p) return state.trackB;
  if (state.playerB.toLowerCase() === p) return state.trackA;
  return null;
}

export function isParticipant(state: ZkMatchState, player: string): boolean {
  const p = player.toLowerCase();
  return state.playerA.toLowerCase() === p || state.playerB.toLowerCase() === p;
}

export {
  encodeCancelMatch,
  encodeCreateMatch,
  encodeJoinMatch,
  encodeSettle,
  encodeSubmitGuess,
  encodeWithdraw,
};

function normalizeTrack(track: readonly unknown[]): ZkTrackState {
  const guessLetters = track[7] as readonly number[];
  return {
    guessCount: Number(track[0]),
    greens: Number(track[1]),
    oranges: Number(track[2]),
    solvedAtGuess: Number(track[3]),
    solved: Boolean(track[4]),
    pendingGuess: Boolean(track[5]),
    deadline: BigInt(track[6] as bigint),
    guessLetters,
    guessWord: lettersToWord(guessLetters),
  };
}

function normalizeOptionalAddress(value: string | undefined): Address | null {
  if (!value) return null;
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

function parseEnvBigInt(value: string | undefined, fallback: bigint): bigint {
  if (!value) return fallback;
  try {
    return BigInt(value);
  } catch {
    return fallback;
  }
}

function randomFieldElement(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return BigInt(hex) & ((1n << 253n) - 1n);
}
