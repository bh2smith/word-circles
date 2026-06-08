"use client";

import { useCallback, useEffect, useState } from "react";
import Board from "./Board";
import Keyboard, { computeLetterStates } from "./Keyboard";
import Toast from "./Toast";
import HintPanel from "./HintPanel";
import StatsModal, { EMPTY_STATS, type Stats } from "./StatsModal";
import InstructionsModal from "./InstructionsModal";
import Leaderboard, { LeaderboardPanel } from "./Leaderboard";
import GroupJoinPrompt from "./GroupJoinPrompt";
import InviteFriend from "./InviteFriend";
import InviteWelcome from "./InviteWelcome";
import ConnectAccount from "./ConnectAccount";
import type { GuessResult, LetterResult } from "@/lib/game";
import { WORD_LENGTH } from "@/lib/game";
import { api } from "@/lib/api/client";
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
  const [showInstructions, setShowInstructions] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(
    getConnectedAddress(),
  );
  const [alreadyPlayed, setAlreadyPlayed] = useState<boolean | null>(null);
  const [recordState, setRecordState] = useState<
    "idle" | "recording" | "recorded" | "error"
  >("idle");

  // Subscribe to wallet + load cached stats on mount. Game state fetch lives in
  // a separate effect so it can re-run when the wallet address resolves.
  useEffect(() => {
    initCircles();
    const unsubscribe = subscribeWallet(setWalletAddress);
    // One-time mount read from localStorage; an effect (not a lazy initializer)
    // keeps the first render SSR-stable and avoids a hydration mismatch.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStats(loadStats());
    return unsubscribe;
  }, []);

  // Fetch game state. When a wallet is available we ask the server for the
  // player's recorded guesses and use them as source of truth — localStorage
  // can be lost (private browsing, ITP, in-app webview), and falling back to a
  // blank board left players unable to submit because the next guess collided
  // on the server's UNIQUE(game_id, player_id, guess_number) constraint.
  useEffect(() => {
    let cancelled = false;

    api
      .GET("/api/game", {
        params: walletAddress
          ? { query: { player: walletAddress } }
          : undefined,
      })
      .then(({ data }) => {
        if (cancelled || !data) return;
        setGameId(data.gameId);

        if (walletAddress && data.guesses != null) {
          const serverGuesses = data.guesses as GuessResult[];
          const serverStatus = (data.status ?? "playing") as
            | "playing"
            | "won"
            | "lost";
          setGuesses(serverGuesses);
          setStatus(serverStatus);
          setAnswer(data.answer ?? undefined);
          if (serverGuesses.length > 0) {
            saveGame({
              gameId: data.gameId,
              guesses: serverGuesses,
              status: serverStatus,
              answer: data.answer ?? undefined,
            });
          }
          if (serverStatus !== "playing") {
            setTimeout(() => setShowStats(true), 500);
          }
          return;
        }

        // No wallet yet — fall back to local cache for visual continuity
        // (submitting a guess requires a wallet anyway).
        const saved = loadGame();
        if (saved && saved.gameId === data.gameId) {
          setGuesses(saved.guesses);
          setStatus(saved.status);
          setAnswer(saved.answer);
          if (saved.status !== "playing") {
            setTimeout(() => setShowStats(true), 500);
          }
        } else {
          setGuesses([]);
          setStatus("playing");
          setAnswer(undefined);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [walletAddress]);

  // Check contract for duplicate play when wallet and gameId are available
  useEffect(() => {
    if (!walletAddress || gameId === null) return;
    // Reset to the loading state before the async on-chain recheck fires when
    // the wallet or game changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
      const { data, error } = await api.POST("/api/guess", {
        body: {
          guess: currentGuess,
          gameId: String(gameId),
          guessNumber: guesses.length,
          player: getConnectedAddress() ?? undefined,
        },
      });

      if (error || !data) {
        setToast(error?.error || "Invalid guess");
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
      <div className="flex flex-col items-center justify-center h-screen gap-4">
        <Wordmark />
        <p className="text-muted">Loading…</p>
      </div>
    );
  }

  // Require a connected wallet to play. Without one (e.g. opened in a plain
  // browser rather than the Circles miniapp) we only reveal the leaderboard,
  // so the day's word can't be solved off the record and replayed in one guess.
  if (!walletAddress) {
    const standalone = !isMiniappMode();
    return (
      <div className="flex flex-col items-center gap-5 w-full max-w-md mx-auto px-4">
        <Wordmark />
        <p className="text-muted text-center">
          {standalone
            ? "Word Circles runs as a mini-app inside the Circles app."
            : "Connect your Circles wallet to play today's word."}
        </p>
        {standalone ? (
          <a
            href={CIRCLES_MINIAPP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="px-6 py-2.5 rounded-full bg-primary text-primary-foreground font-bold shadow-sm transition hover:opacity-90 active:scale-95"
          >
            Open in Circles
          </a>
        ) : (
          <ConnectAccount />
        )}
        <div className="w-full bg-surface border border-border rounded-2xl p-6 max-h-[70vh] flex flex-col shadow-sm">
          <h2 className="text-center text-lg font-bold mb-4 uppercase tracking-wide text-muted">
            Leaderboard
          </h2>
          <LeaderboardPanel gameId={gameId} />
        </div>
      </div>
    );
  }

  if (alreadyPlayed === null) {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-4">
        <Wordmark />
        <p className="text-muted">Checking game status…</p>
      </div>
    );
  }

  if (alreadyPlayed && status === "playing") {
    return (
      <div className="flex flex-col items-center justify-center h-screen gap-3">
        <Wordmark />
        <p className="text-muted text-sm">Game #{gameId}</p>
        <p className="text-lg font-semibold">
          You&apos;ve already played today!
        </p>
        <p className="text-faint text-sm">Come back tomorrow for a new word.</p>
        <button
          onClick={() => setShowLeaderboard(true)}
          className="mt-2 px-5 py-2 text-sm font-semibold rounded-full bg-primary text-primary-foreground shadow-sm transition hover:opacity-90 active:scale-95"
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
          className="w-10 h-10 flex items-center justify-center text-muted hover:text-foreground hover:bg-primary-soft rounded-full transition-colors"
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
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowInstructions(true)}
            className="w-10 h-10 flex items-center justify-center text-muted hover:text-foreground hover:bg-primary-soft rounded-full transition-colors"
            aria-label="How to play"
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <path
                d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <line x1="12" y1="17" x2="12.01" y2="17" strokeLinecap="round" />
            </svg>
          </button>
          <button
            onClick={() => setShowStats(true)}
            className="w-10 h-10 flex items-center justify-center text-muted hover:text-foreground hover:bg-primary-soft rounded-full transition-colors"
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
      </div>

      {/* Game number */}
      <p className="text-muted text-sm font-medium">Game #{gameId}</p>

      {/* Greet newcomers who arrived via an invite link (renders nothing
          otherwise). */}
      <InviteWelcome />

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

      {/* Hint below keyboard */}
      <div className="w-full max-w-lg">
        <HintPanel
          guesses={guesses}
          onSelectWord={setCurrentGuess}
          revealWords={false}
        />
      </div>

      {/* Post-win: offer group onboarding to unlock PvP (renders nothing if
          already a member / PvP already available / group not configured). */}
      {status === "won" && walletAddress && (
        <div className="flex w-full max-w-md flex-col items-center gap-3">
          <GroupJoinPrompt address={walletAddress} />
          <InviteFriend address={walletAddress} />
        </div>
      )}

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

      {/* Instructions Modal */}
      <InstructionsModal
        open={showInstructions}
        onClose={() => setShowInstructions(false)}
      />
    </div>
  );
}

// Two-tone wordmark with the concentric-circles brand glyph. Colors are wired
// to the theme tokens so it flips with light/dark automatically.
function Wordmark() {
  return (
    <div className="flex items-center gap-2.5">
      <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
        <circle
          cx="15"
          cy="15"
          r="13"
          fill="none"
          stroke="var(--primary)"
          strokeWidth="2.5"
        />
        <circle
          cx="15"
          cy="15"
          r="7.5"
          fill="none"
          stroke="var(--secondary)"
          strokeWidth="2.5"
        />
        <circle cx="15" cy="15" r="2.5" fill="var(--primary)" />
      </svg>
      <h1 className="text-2xl font-extrabold tracking-tight">
        <span className="text-primary">Word</span>{" "}
        <span className="text-secondary">Circles</span>
      </h1>
    </div>
  );
}
