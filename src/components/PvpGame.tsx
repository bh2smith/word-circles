"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Board from "./Board";
import Keyboard, { computeLetterStates } from "./Keyboard";
import Toast from "./Toast";
import HintPanel from "./HintPanel";
import OpponentStatus from "./OpponentStatus";
import PvpResults from "./PvpResults";
import { formatUnits } from "viem";
import type { GuessResult, LetterResult } from "@/lib/game";
import { WORD_LENGTH } from "@/lib/game";
import {
  initCircles,
  isMiniappMode,
  subscribeWallet,
  getConnectedAddress,
  joinPvpGame,
  NoCirclesError,
  CIRCLES_MINIAPP_URL,
} from "@/lib/circles";
import { encodeApprove, encodeJoin } from "@/lib/contract";
import type {
  ContractConfig,
  PvpGameResponse,
  PvpTranscript,
  GuessResponse,
  ErrorResponse,
} from "@/lib/api";

// Lobby lifecycle. Matchmaking is on-chain (escrow.join), so after submitting
// we discover the assigned gameId from the backend, then poll until the game
// fills and the resolver commits the word (status -> "active").
type Phase =
  | "submitting" // approve + join sent, awaiting wallet
  | "discovering" // looking up the assigned gameId
  | "waiting" // joined, waiting for an opponent
  | "playing"
  | "finished"; // local board done; awaiting settlement

interface SavedPvp {
  gameId: string;
  guesses: GuessResult[];
  phase: Phase;
}

const STORAGE_KEY = "wordcircle-pvp";

function loadSaved(): SavedPvp | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function truncate(addr: string): string {
  return addr.length <= 10 ? addr : `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

export default function PvpGame() {
  const [config, setConfig] = useState<ContractConfig | null>(null);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(
    getConnectedAddress(),
  );

  const [phase, setPhase] = useState<Phase | null>(null); // null = idle/lobby
  const [gameId, setGameId] = useState<string | null>(null);
  const [game, setGame] = useState<PvpGameResponse | null>(null);
  const [transcript, setTranscript] = useState<PvpTranscript | null>(null);
  const [guesses, setGuesses] = useState<GuessResult[]>([]);
  const [currentGuess, setCurrentGuess] = useState("");
  const [solved, setSolved] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [shake, setShake] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // gameIds the player was already in before the latest join, so we can pick
  // out the newly created one during discovery.
  const beforeIdsRef = useRef<Set<string>>(new Set());

  // Load config + wallet, and resume any in-progress game.
  useEffect(() => {
    initCircles();
    const unsubscribe = subscribeWallet(setWalletAddress);

    fetch("/api/config")
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg: ContractConfig | null) => setConfig(cfg))
      .catch(() => setConfig(null))
      .finally(() => setConfigLoaded(true));

    // A ?game=<id> param (e.g. from the history page) re-enters that specific
    // game. If it matches the locally-saved game we restore its guesses too;
    // otherwise we enter with an empty board and let polling derive the live
    // phase (a settled game lands on the results view, an ongoing one on the
    // board). Falls back to the locally-saved in-progress game.
    const requested =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("game")
        : null;
    const saved = loadSaved();

    if (requested) {
      setGameId(requested);
      if (saved && saved.gameId === requested) {
        setGuesses(saved.guesses);
        setPhase(saved.phase === "finished" ? "finished" : "playing");
      } else {
        setPhase("waiting"); // polling re-derives the real phase
      }
    } else if (saved && saved.gameId) {
      setGameId(saved.gameId);
      setGuesses(saved.guesses);
      // submitting/discovering are transient — resume into the waiting screen
      // and let polling re-derive the live phase.
      setPhase(
        saved.phase === "playing" || saved.phase === "finished"
          ? saved.phase
          : "waiting",
      );
    }

    return unsubscribe;
  }, []);

  // Persist resumable phases.
  useEffect(() => {
    if (
      gameId &&
      (phase === "waiting" || phase === "playing" || phase === "finished")
    ) {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ gameId, guesses, phase } satisfies SavedPvp),
      );
    }
  }, [gameId, guesses, phase]);

  const clearSaved = useCallback(() => {
    if (typeof window !== "undefined") localStorage.removeItem(STORAGE_KEY);
  }, []);

  const shakeOnce = useCallback(() => {
    setShake(true);
    setTimeout(() => setShake(false), 600);
  }, []);

  const fetchActiveGames = useCallback(
    async (address: string): Promise<PvpGameResponse[]> => {
      const res = await fetch(
        `/api/games?player=${encodeURIComponent(address)}&active=true`,
      );
      if (!res.ok) return [];
      return res.json();
    },
    [],
  );

  const findMatch = useCallback(async () => {
    if (!config || !walletAddress) return;
    const { escrowAddress, token, amount, resolver } = config;
    const capacity = config.capacity ?? 2;
    if (!escrowAddress || !token || !amount) {
      setToast("PvP is not configured");
      return;
    }
    setPhase("submitting");
    try {
      const stake = BigInt(amount);
      const approveData = encodeApprove(escrowAddress, stake);
      const joinData = encodeJoin(resolver, token, stake, capacity);
      const before = await fetchActiveGames(walletAddress);
      beforeIdsRef.current = new Set(before.map((g) => g.gameId));
      // Passing player + stake lets joinPvpGame mint the stake token from the
      // player's personal CRC when they don't already hold enough s-gCRC.
      await joinPvpGame({
        escrow: escrowAddress,
        token,
        approveData,
        joinData,
        player: walletAddress,
        stake,
      });
      setPhase("discovering");
    } catch (err) {
      console.error("PvP join failed:", err);
      if (err instanceof NoCirclesError) {
        setToast(
          "You need Circles (CRC) to play PvP — none found in this wallet",
        );
      } else {
        setToast("Couldn't join — transaction rejected or reverted");
      }
      setPhase(null);
    }
  }, [config, walletAddress, fetchActiveGames]);

  // Discover the gameId assigned on-chain once the join is indexed.
  useEffect(() => {
    if (phase !== "discovering" || !walletAddress) return;
    let active = true;
    const startedAt = Date.now();

    const tick = async () => {
      const games = await fetchActiveGames(walletAddress);
      if (!active) return;
      const fresh = games.find((g) => !beforeIdsRef.current.has(g.gameId));
      const chosen = fresh ?? games[0];
      if (chosen) {
        setGameId(chosen.gameId);
        setGame(chosen);
        setPhase(chosen.status === "active" ? "playing" : "waiting");
      } else if (Date.now() - startedAt > 60_000) {
        setToast("Couldn't find your game yet — it may still be pending.");
        setPhase(null);
      }
    };

    tick();
    const id = setInterval(tick, 2500);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [phase, walletAddress, fetchActiveGames]);

  // Poll the live game state while waiting, playing, or awaiting settlement.
  useEffect(() => {
    if (
      !gameId ||
      (phase !== "waiting" && phase !== "playing" && phase !== "finished")
    ) {
      return;
    }
    let active = true;

    const tick = async () => {
      const res = await fetch(`/api/games/${gameId}`);
      if (!active || !res.ok) return;
      const g: PvpGameResponse = await res.json();
      if (!active) return;
      setGame(g);
      const isSettled = g.status === "settled" || g.status === "completed";
      // A re-entered or already-finished game that's settled jumps straight to
      // the results view; otherwise an opponent arriving promotes us to playing.
      if (isSettled) {
        if (phase !== "finished") setPhase("finished");
      } else if (phase === "waiting" && g.status === "active") {
        setPhase("playing");
      }
    };

    tick();
    const id = setInterval(tick, 2500);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [gameId, phase]);

  // Once the game has settled, fetch both players' transcripts for the
  // head-to-head results screen.
  useEffect(() => {
    const settled = game?.status === "settled" || game?.status === "completed";
    if (!gameId || !settled || transcript) return;
    let active = true;
    fetch(`/api/games/${gameId}/transcript`)
      .then((r) => (r.ok ? r.json() : null))
      .then((t: PvpTranscript | null) => {
        if (active && t) setTranscript(t);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [gameId, game?.status, transcript]);

  const submitGuess = useCallback(async () => {
    if (
      phase !== "playing" ||
      !gameId ||
      currentGuess.length !== WORD_LENGTH ||
      submitting
    ) {
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/guess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guess: currentGuess,
          gameId,
          guessNumber: guesses.length,
          // Lowercase: the backend stores player addresses lowercase and (on the
          // currently-deployed version) matches them exactly, so a checksummed
          // address is rejected as "Not a player in this game". Lowercasing also
          // passes the case-insensitive match once the backend fix ships.
          player: walletAddress?.toLowerCase() ?? undefined,
        }),
      });
      const data: GuessResponse & Partial<ErrorResponse> = await res.json();
      if (!res.ok) {
        setToast(data.error || "Invalid guess");
        shakeOnce();
        return;
      }
      const newGuesses = [
        ...guesses,
        { word: data.guess, results: data.results as LetterResult[] },
      ];
      setGuesses(newGuesses);
      setCurrentGuess("");
      if (data.won) {
        setSolved(true);
        setToast("Solved! Waiting for settlement…");
        setPhase("finished");
      } else if (data.gameOver) {
        setPhase("finished");
      }
    } finally {
      setSubmitting(false);
    }
  }, [
    phase,
    gameId,
    currentGuess,
    guesses,
    submitting,
    walletAddress,
    shakeOnce,
  ]);

  const onKey = useCallback(
    (key: string) => {
      if (phase !== "playing" || submitting) return;
      if (key === "Enter") {
        if (currentGuess.length === WORD_LENGTH) submitGuess();
        else {
          setToast("Not enough letters");
          shakeOnce();
        }
        return;
      }
      if (key === "⌫" || key === "Backspace") {
        setCurrentGuess((p) => p.slice(0, -1));
        return;
      }
      if (/^[a-zA-Z]$/.test(key) && currentGuess.length < WORD_LENGTH) {
        setCurrentGuess((p) => p + key.toLowerCase());
      }
    },
    [phase, submitting, currentGuess, submitGuess, shakeOnce],
  );

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      onKey(e.key);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onKey]);

  const resetToLobby = useCallback(() => {
    clearSaved();
    setPhase(null);
    setGameId(null);
    setGame(null);
    setTranscript(null);
    setGuesses([]);
    setCurrentGuess("");
    setSolved(false);
  }, [clearSaved]);

  // --- Rendering ---------------------------------------------------------

  const title = (
    <h1 className="text-2xl font-bold tracking-wider text-white">
      PVP CIRCLES
    </h1>
  );

  if (!configLoaded) {
    return (
      <div className="flex flex-col items-center gap-4 text-white">
        {title}
        <p className="text-neutral-400">Loading…</p>
      </div>
    );
  }

  const pvpAvailable =
    config?.pvpEnabled && config.escrowAddress && config.token && config.amount;

  if (!pvpAvailable) {
    return (
      <div className="flex flex-col items-center gap-4 text-white px-4 text-center">
        {title}
        <p className="text-neutral-400">
          PvP isn&apos;t available right now. Check back soon.
        </p>
      </div>
    );
  }

  if (!walletAddress) {
    const standalone = !isMiniappMode();
    return (
      <div className="flex flex-col items-center gap-4 text-white px-4 text-center">
        {title}
        <p className="text-neutral-400">
          {standalone
            ? "PvP runs inside the Circles app — open Word Circles there to stake and race."
            : "Connect your Circles wallet to play head-to-head."}
        </p>
        {standalone && (
          <a
            href={CIRCLES_MINIAPP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="px-6 py-2.5 rounded-lg bg-green-600 font-bold hover:bg-green-500 transition-colors"
          >
            Open in Circles
          </a>
        )}
      </div>
    );
  }

  const stakeLabel = (() => {
    try {
      // Circles tokens are 18 decimals. formatUnits keeps fractional stakes
      // (e.g. "0.1 CRC") instead of integer-dividing sub-1 amounts to "0 CRC".
      return `${formatUnits(BigInt(config!.amount!), 18)} CRC`;
    } catch {
      return "the entry stake";
    }
  })();

  const Header = (
    <div className="flex flex-col items-center gap-1">
      {title}
      <p className="text-neutral-500 text-xs font-mono">
        {truncate(walletAddress)}
      </p>
    </div>
  );

  if (phase === null) {
    return (
      <div className="flex flex-col items-center gap-5 text-white px-4 text-center max-w-md">
        {Header}
        <p className="text-neutral-400">
          Stake {stakeLabel} and race an opponent on the same word. Fewest
          guesses wins the pot.
        </p>
        <button
          onClick={findMatch}
          className="px-6 py-2.5 rounded-lg bg-green-600 font-bold hover:bg-green-500 transition-colors"
        >
          Find Match
        </button>
        {toast && <Toast message={toast} onDone={() => setToast(null)} />}
      </div>
    );
  }

  if (phase === "submitting") {
    return (
      <div className="flex flex-col items-center gap-4 text-white px-4 text-center">
        {Header}
        <p className="text-neutral-400">
          Confirm the approve + join in your wallet…
        </p>
        {toast && <Toast message={toast} onDone={() => setToast(null)} />}
      </div>
    );
  }

  if (phase === "discovering") {
    return (
      <div className="flex flex-col items-center gap-4 text-white px-4 text-center">
        {Header}
        <p className="text-neutral-400 animate-pulse">Finding your game…</p>
        {toast && <Toast message={toast} onDone={() => setToast(null)} />}
      </div>
    );
  }

  if (phase === "waiting") {
    const joined = game?.players.length ?? 1;
    const capacity = game?.capacity ?? config?.capacity ?? 2;
    return (
      <div className="flex flex-col items-center gap-4 text-white px-4 text-center max-w-md">
        {Header}
        <p className="text-lg">Waiting for an opponent…</p>
        <p className="text-neutral-400">
          {joined}/{capacity} joined
        </p>
        <span className="inline-flex gap-1">
          <span className="w-2 h-2 bg-green-500 rounded-full animate-bounce [animation-delay:-0.3s]" />
          <span className="w-2 h-2 bg-green-500 rounded-full animate-bounce [animation-delay:-0.15s]" />
          <span className="w-2 h-2 bg-green-500 rounded-full animate-bounce" />
        </span>
        <button
          onClick={resetToLobby}
          className="mt-2 px-4 py-2 text-sm font-semibold rounded bg-neutral-700 hover:bg-neutral-600 transition-colors"
        >
          Stop waiting
        </button>
        <p className="text-neutral-600 text-xs">
          Your stake stays escrowed until the game fills and settles (or the
          timeout refund applies). Stopping only hides this screen.
        </p>
      </div>
    );
  }

  const settled = game?.status === "settled" || game?.status === "completed";

  // Settled — show the head-to-head results once the transcript loads.
  if (phase === "finished" && settled && transcript) {
    return (
      <PvpResults
        transcript={transcript}
        myAddress={walletAddress}
        onPlayAgain={resetToLobby}
      />
    );
  }

  // playing / finished — show the board.
  const letterStates = computeLetterStates(guesses);
  const answer = game?.answer;
  const opponent =
    game?.players.find(
      (p) => p.address.toLowerCase() !== walletAddress.toLowerCase(),
    ) ?? null;

  return (
    <div className="relative flex flex-col items-center gap-4 sm:gap-6 w-full max-w-lg mx-auto px-2 text-white">
      {Header}

      <OpponentStatus opponent={opponent} settled={settled} />

      {phase === "finished" && (
        <div className="text-center">
          {settled && answer ? (
            <>
              <p className="text-lg font-semibold">
                {solved ? "You solved it!" : "Out of guesses"}
              </p>
              <p className="text-neutral-400">
                The word was{" "}
                <span className="font-bold uppercase tracking-wider">
                  {answer}
                </span>
              </p>
            </>
          ) : (
            <p className="text-neutral-400 animate-pulse">
              You finished. Waiting for the result…
            </p>
          )}
        </div>
      )}

      {toast && <Toast message={toast} onDone={() => setToast(null)} />}

      <Board guesses={guesses} currentGuess={currentGuess} shake={shake} />

      {phase === "playing" && (
        <>
          <Keyboard
            letterStates={letterStates}
            onKey={onKey}
            disabled={submitting}
          />
          <div className="flex items-start justify-between w-full max-w-lg gap-2">
            <HintPanel guesses={guesses} onSelectWord={setCurrentGuess} />
            <button
              onClick={submitGuess}
              disabled={currentGuess.length !== WORD_LENGTH || submitting}
              className="shrink-0 px-4 py-2 text-sm font-semibold rounded bg-green-600 text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-green-500 transition-colors"
            >
              Submit
            </button>
          </div>
        </>
      )}

      {phase === "finished" && settled && (
        <button
          onClick={resetToLobby}
          className="px-6 py-2.5 rounded-lg bg-green-600 font-bold hover:bg-green-500 transition-colors"
        >
          Play Again
        </button>
      )}
    </div>
  );
}
