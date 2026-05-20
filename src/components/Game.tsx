"use client";

import { useCallback, useEffect, useState } from "react";
import Board from "./Board";
import Keyboard, { computeLetterStates } from "./Keyboard";
import Toast from "./Toast";
import StatsModal, { EMPTY_STATS, type Stats } from "./StatsModal";
import type { GuessResult, LetterResult } from "@/lib/game";
import { MAX_GUESSES, WORD_LENGTH } from "@/lib/game";
import { isMiniappMode, initCircles, submitGameResult } from "@/lib/circles";
import { STATS_CONTRACT, encodeRecordGame } from "@/lib/contract";

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
  const [submitting, setSubmitting] = useState(false);

  // Load game state and fetch current game ID
  useEffect(() => {
    initCircles();
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
  }, []);

  const recordOnChain = useCallback(
    async (gId: number, won: boolean, numGuesses: number) => {
      if (!isMiniappMode()) return;
      try {
        const calldata = encodeRecordGame(gId, won, numGuesses);
        await submitGameResult(STATS_CONTRACT, calldata);
      } catch (err) {
        console.error("On-chain recording failed:", err);
      }
    },
    [],
  );

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
          gameId,
          guessNumber: guesses.length,
        }),
      });

      const data = await res.json();

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
        newAnswer = data.answer;
        setToast("Brilliant!");
        updateStats(true, newGuesses.length);
        recordOnChain(gameId, true, newGuesses.length);
      } else if (data.gameOver) {
        newStatus = "lost";
        newAnswer = data.answer;
        updateStats(false, newGuesses.length);
        recordOnChain(gameId, false, newGuesses.length);
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
  }, [
    currentGuess,
    gameId,
    guesses,
    status,
    submitting,
    updateStats,
    recordOnChain,
  ]);

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
      <div className="flex items-center justify-center h-screen text-white">
        Loading...
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-4 sm:gap-6 w-full max-w-lg mx-auto px-2">
      {/* Header */}
      <div className="flex items-center justify-between w-full">
        <div className="w-10" />
        <h1 className="text-2xl sm:text-3xl font-bold tracking-wider text-white">
          WORD CIRCLE
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

      {/* Stats Modal */}
      <StatsModal
        stats={stats}
        open={showStats}
        onClose={() => setShowStats(false)}
        gameOver={status !== "playing"}
        won={status === "won"}
        answer={answer}
      />
    </div>
  );
}
