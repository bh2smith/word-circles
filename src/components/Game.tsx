"use client";

import { useCallback, useEffect, useState } from "react";
import Board from "./Board";
import Keyboard, { computeLetterStates } from "./Keyboard";
import Toast from "./Toast";
import HintPanel from "./HintPanel";
import StatsModal, { EMPTY_STATS, type Stats } from "./StatsModal";
import Leaderboard, { LeaderboardPanel } from "./Leaderboard";
import type { GuessResult, LetterResult } from "@/lib/game";
import { MAX_GUESSES, WORD_LENGTH } from "@/lib/game";
import type { GuessResponse, ErrorResponse } from "@/lib/api";
import {
  isMiniappMode,
  initCircles,
  submitGameResult,
  getConnectedAddress,
  subscribeWallet,
  CIRCLES_MINIAPP_URL,
} from "@/lib/circles";
import {
  STATS_CONTRACT,
  encodeRecordGame,
  hasPlayerPlayed,
} from "@/lib/contract";

interface SavedGame {
  gameId: number;
  guesses: GuessResult[];
  status: "playing" | "won" | "lost";
  answer?: string;
}

function loadGame(): SavedGame | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem("wordcircle-game");
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveGame(game: SavedGame) {
  localStorage.setItem("wordcircle-game", JSON.stringify(game));
}

function loadStats(): Stats {
  if (typeof window === "undefined") return EMPTY_STATS;
  try {
    const raw = localStorage.getItem("wordcircle-stats");
    return raw ? JSON.parse(raw) : EMPTY_STATS;
  } catch {
    return EMPTY_STATS;
  }
}

function saveStats(stats: Stats) {
  localStorage.setItem("wordcircle-stats", JSON.stringify(stats));
}

export default function Game() {
  const [gameId, setGameId] = useState<number | null>(null);
  const [guesses, setGuesses] = useState<GuessResult[]>([]);
  const [currentGuess, setCurrentGuess] = useState("");
  const [status, setStatus] = useState<"playing" | "won" | "lost">("playing");
  const [answer, setAnswer] = useState<string | undefined>();
  const [shake, setShake] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [stats, setStats] = useState<Stats>(EMPTY_STATS);
  const [showStats, setShowStats] = useState(false);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(
    getConnectedAddress(),
  );
  const [alreadyPlayed, setAlreadyPlayed] = useState<boolean | null>(null);
  const [recordState, setRecordState] = useState<
    "idle" | "recording" | "recorded" | "error"
  >("idle");

  // Load game state, fetch current game ID, and subscribe to wallet
  useEffect(() => {
    initCircles();
    const unsubscribe = subscribeWallet(setWalletAddress);
    const savedStats = loadStats();
    setStats(savedStats);

    fetch("/api/game")
      .then((r) => r.json())
      .then(({ gameId: serverGameId }) => {
        const saved = loadGame();
        if (saved && saved.gameId === serverGameId) {
          setGameId(saved.gameId);
          setGuesses(saved.guesses);
          setStatus(saved.status);
          setAnswer(saved.answer);
          if (saved.status !== "playing") {
            setTimeout(() => setShowStats(true), 500);
          }
        } else {
          setGameId(serverGameId);
          setGuesses([]);
          setStatus("playing");
          setAnswer(undefined);
        }
      });

    return unsubscribe;
  }, []);

  // Check contract for duplicate play when wallet and gameId are available
  useEffect(() => {
    if (!walletAddress || gameId === null) return;
    setAlreadyPlayed(null);
    hasPlayerPlayed(walletAddress, gameId)
      .then(setAlreadyPlayed)
      .catch(() => setAlreadyPlayed(false));
  }, [walletAddress, gameId]);

  // Submit the finished game to the on-chain leaderboard. Triggered by the
  // user via the "Record Score" button rather than automatically, so the
  // wallet transaction prompt doesn't surprise them.
  const handleRecordScore = useCallback(async () => {
    if (gameId === null || status === "playing") return;
    setRecordState("recording");
    try {
      const calldata = encodeRecordGame(
        gameId,
        status === "won",
        guesses.length,
      );
      await submitGameResult(STATS_CONTRACT, calldata);
      setRecordState("recorded");
    } catch (err) {
      console.error("On-chain recording failed:", err);
      setRecordState("error");
    }
  }, [gameId, status, guesses.length]);

  const updateStats = useCallback((won: boolean, numGuesses: number) => {
    setStats((prev) => {
      const next: Stats = {
        gamesPlayed: prev.gamesPlayed + 1,
        gamesWon: prev.gamesWon + (won ? 1 : 0),
        currentStreak: won ? prev.currentStreak + 1 : 0,
        maxStreak: won
          ? Math.max(prev.maxStreak, prev.currentStreak + 1)
          : prev.maxStreak,
        guessDistribution: [...prev.guessDistribution],
      };
      if (won) {
        next.guessDistribution[numGuesses - 1]++;
      }
      saveStats(next);
      return next;
    });
  }, []);

  const submitGuess = useCallback(async () => {
    if (
      status !== "playing" ||
      gameId === null ||
      currentGuess.length !== WORD_LENGTH ||
      submitting
    )
      return;

    setSubmitting(true);
    try {
      const res = await fetch("/api/guess", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guess: currentGuess,
          gameId: String(gameId),
          guessNumber: guesses.length,
          player: getConnectedAddress() ?? undefined,
        }),
      });

      const data: GuessResponse & Partial<ErrorResponse> = await res.json();

      if (!res.ok) {
        setToast(data.error || "Invalid guess");
        setShake(true);
        setTimeout(() => setShake(false), 600);
        return;
      }

      const newGuess: GuessResult = {
        word: data.guess,
        results: data.results as LetterResult[],
      };

      const newGuesses = [...guesses, newGuess];
      setGuesses(newGuesses);
      setCurrentGuess("");

      let newStatus: "playing" | "won" | "lost" = "playing";
      let newAnswer: string | undefined;

      if (data.won) {
        newStatus = "won";
        newAnswer = data.answer ?? undefined;
        setToast("Brilliant!");
        updateStats(true, newGuesses.length);
      } else if (data.gameOver) {
        newStatus = "lost";
        newAnswer = data.answer ?? undefined;
        updateStats(false, newGuesses.length);
      }

      setStatus(newStatus);
      setAnswer(newAnswer);
      saveGame({
        gameId,
        guesses: newGuesses,
        status: newStatus,
        answer: newAnswer,
      });

      if (newStatus !== "playing") {
        setTimeout(() => setShowStats(true), 1500);
      }
    } finally {
      setSubmitting(false);
    }
  }, [currentGuess, gameId, guesses, status, submitting, updateStats]);

  const onKey = useCallback(
    (key: string) => {
      if (status !== "playing" || submitting) return;

      if (key === "Enter") {
        if (currentGuess.length === WORD_LENGTH) {
          submitGuess();
        } else {
          setToast("Not enough letters");
          setShake(true);
          setTimeout(() => setShake(false), 600);
        }
        return;
      }

      if (key === "⌫" || key === "Backspace") {
        setCurrentGuess((prev) => prev.slice(0, -1));
        return;
      }

      if (/^[a-zA-Z]$/.test(key) && currentGuess.length < WORD_LENGTH) {
        setCurrentGuess((prev) => prev + key.toLowerCase());
      }
    },
    [currentGuess, status, submitting, submitGuess],
  );

  // Physical keyboard
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      onKey(e.key);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onKey]);

  const letterStates = computeLetterStates(guesses);

  if (gameId === null) {
    return (
      <div className="flex flex-col items-center justify-center h-screen text-white gap-4">
        <h1 className="text-2xl font-bold tracking-wider">WORD CIRCLES</h1>
        <p className="text-neutral-400">Loading...</p>
      </div>
    );
  }

  // Require a connected wallet to play. Without one (e.g. opened in a plain
  // browser rather than the Circles miniapp) we only reveal the leaderboard,
  // so the day's word can't be solved off the record and replayed in one guess.
  if (!walletAddress) {
    const standalone = !isMiniappMode();
    return (
      <div className="flex flex-col items-center gap-5 w-full max-w-md mx-auto px-4 text-white">
        <h1 className="text-2xl font-bold tracking-wider">WORD CIRCLES</h1>
        <p className="text-neutral-400 text-center">
          {standalone
            ? "Word Circles runs as a mini-app inside the Circles app."
            : "Connect your Circles wallet to play today's word."}
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
        <div className="w-full bg-neutral-800 rounded-xl p-6 max-h-[70vh] flex flex-col">
          <h2 className="text-center text-lg font-bold mb-4 uppercase tracking-wider">
            Leaderboard
          </h2>
          <LeaderboardPanel gameId={gameId} />
        </div>
      </div>
    );
  }

  if (alreadyPlayed === null) {
    return (
      <div className="flex flex-col items-center justify-center h-screen text-white gap-4">
        <h1 className="text-2xl font-bold tracking-wider">WORD CIRCLES</h1>
        <p className="text-neutral-400">Checking game status...</p>
      </div>
    );
  }

  if (alreadyPlayed && status === "playing") {
    return (
      <div className="flex flex-col items-center justify-center h-screen text-white gap-4">
        <h1 className="text-2xl font-bold tracking-wider">WORD CIRCLES</h1>
        <p className="text-neutral-400">Game #{gameId}</p>
        <p className="text-lg">You&apos;ve already played today!</p>
        <p className="text-neutral-500 text-sm">
          Come back tomorrow for a new word.
        </p>
        <button
          onClick={() => setShowLeaderboard(true)}
          className="mt-2 px-4 py-2 text-sm font-semibold rounded bg-green-600 text-white hover:bg-green-500 transition-colors"
        >
          View Leaderboard
        </button>
        <Leaderboard
          open={showLeaderboard}
          onClose={() => setShowLeaderboard(false)}
          gameId={gameId}
        />
      </div>
    );
  }

  return (
    <div className="relative flex flex-col items-center gap-4 sm:gap-6 w-full max-w-lg mx-auto px-2">
      {/* Header */}
      <div className="flex items-center justify-between w-full">
        <button
          onClick={() => setShowLeaderboard(true)}
          className="w-10 h-10 flex items-center justify-center text-white hover:bg-neutral-700 rounded transition-colors"
          aria-label="Leaderboard"
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M12 15l-3 3h6l-3-3z" />
            <rect x="3" y="10" width="5" height="8" rx="1" />
            <rect x="9.5" y="5" width="5" height="13" rx="1" />
            <rect x="16" y="8" width="5" height="10" rx="1" />
          </svg>
        </button>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-wider text-white">
          WORD CIRCLES
        </h1>
        <button
          onClick={() => setShowStats(true)}
          className="w-10 h-10 flex items-center justify-center text-white hover:bg-neutral-700 rounded transition-colors"
          aria-label="Statistics"
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect x="4" y="14" width="4" height="7" rx="1" />
            <rect x="10" y="9" width="4" height="12" rx="1" />
            <rect x="16" y="4" width="4" height="17" rx="1" />
          </svg>
        </button>
      </div>

      {/* Game number */}
      <p className="text-neutral-400 text-sm">Game #{gameId}</p>

      {/* Toast */}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}

      {/* Board */}
      <Board guesses={guesses} currentGuess={currentGuess} shake={shake} />

      {/* Keyboard */}
      <Keyboard
        letterStates={letterStates}
        onKey={onKey}
        disabled={status !== "playing" || submitting}
      />

      {/* Hint + Submit below keyboard */}
      <div className="flex items-start justify-between w-full max-w-lg gap-2">
        <HintPanel guesses={guesses} onSelectWord={setCurrentGuess} />
        {status === "playing" && (
          <button
            onClick={submitGuess}
            disabled={currentGuess.length !== WORD_LENGTH || submitting}
            className="shrink-0 px-4 py-2 text-sm font-semibold rounded bg-green-600 text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-green-500 transition-colors"
          >
            Submit
          </button>
        )}
      </div>

      {/* Stats Modal */}
      <StatsModal
        stats={stats}
        open={showStats}
        onClose={() => setShowStats(false)}
        gameOver={status !== "playing"}
        won={status === "won"}
        answer={answer}
        canRecord={isMiniappMode()}
        recordState={
          recordState === "idle" && alreadyPlayed ? "recorded" : recordState
        }
        onRecordScore={handleRecordScore}
      />

      {/* Leaderboard Modal */}
      <Leaderboard
        open={showLeaderboard}
        onClose={() => setShowLeaderboard(false)}
        gameId={gameId}
      />
    </div>
  );
}
