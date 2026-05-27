"use client";

export interface Stats {
  gamesPlayed: number;
  gamesWon: number;
  currentStreak: number;
  maxStreak: number;
  guessDistribution: number[];
}

export const EMPTY_STATS: Stats = {
  gamesPlayed: 0,
  gamesWon: 0,
  currentStreak: 0,
  maxStreak: 0,
  guessDistribution: [0, 0, 0, 0, 0, 0],
};

export type RecordState = "idle" | "recording" | "recorded" | "error";

interface StatsModalProps {
  stats: Stats;
  open: boolean;
  onClose: () => void;
  gameOver?: boolean;
  won?: boolean;
  answer?: string;
  /** Whether on-chain recording is available (i.e. running in the miniapp). */
  canRecord?: boolean;
  recordState?: RecordState;
  onRecordScore?: () => void;
}

export default function StatsModal({
  stats,
  open,
  onClose,
  gameOver,
  won,
  answer,
  canRecord,
  recordState = "idle",
  onRecordScore,
}: StatsModalProps) {
  if (!open) return null;

  const showRecord = gameOver && canRecord;

  const winPct =
    stats.gamesPlayed > 0
      ? Math.round((stats.gamesWon / stats.gamesPlayed) * 100)
      : 0;

  const maxDist = Math.max(...stats.guessDistribution, 1);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={onClose}
    >
      <div
        className="bg-neutral-800 rounded-xl p-6 max-w-sm w-full mx-4 text-white"
        onClick={(e) => e.stopPropagation()}
      >
        {gameOver && (
          <div className="text-center mb-4">
            <p className="text-xl font-bold">
              {won ? "Congratulations!" : "Better luck next time"}
            </p>
            {answer && (
              <p className="text-neutral-400 mt-1">
                The word was{" "}
                <span className="font-bold uppercase text-white">{answer}</span>
              </p>
            )}
          </div>
        )}

        <h2 className="text-center text-lg font-bold mb-4 uppercase tracking-wider">
          Statistics
        </h2>

        <div className="grid grid-cols-4 gap-2 text-center mb-6">
          <div>
            <p className="text-2xl font-bold">{stats.gamesPlayed}</p>
            <p className="text-xs text-neutral-400">Played</p>
          </div>
          <div>
            <p className="text-2xl font-bold">{winPct}</p>
            <p className="text-xs text-neutral-400">Win %</p>
          </div>
          <div>
            <p className="text-2xl font-bold">{stats.currentStreak}</p>
            <p className="text-xs text-neutral-400">Streak</p>
          </div>
          <div>
            <p className="text-2xl font-bold">{stats.maxStreak}</p>
            <p className="text-xs text-neutral-400">Max</p>
          </div>
        </div>

        <h3 className="text-sm font-bold uppercase tracking-wider mb-2">
          Guess Distribution
        </h3>
        <div className="space-y-1">
          {stats.guessDistribution.map((count, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-sm w-3 text-right">{i + 1}</span>
              <div
                className="bg-neutral-600 h-5 rounded-sm flex items-center justify-end px-1.5 text-xs font-bold min-w-[1.5rem] transition-all"
                style={{
                  width: `${Math.max((count / maxDist) * 100, 8)}%`,
                }}
              >
                {count}
              </div>
            </div>
          ))}
        </div>

        {showRecord && (
          <button
            onClick={onRecordScore}
            disabled={recordState === "recording" || recordState === "recorded"}
            className={`mt-6 w-full py-2 rounded font-bold transition-colors disabled:cursor-not-allowed ${
              recordState === "recorded"
                ? "bg-neutral-700 text-neutral-300"
                : "bg-green-600 hover:bg-green-700 disabled:opacity-60"
            }`}
          >
            {recordState === "recording"
              ? "Recording…"
              : recordState === "recorded"
                ? "Score Recorded ✓"
                : recordState === "error"
                  ? "Recording failed — Retry"
                  : "Record Score"}
          </button>
        )}

        <button
          onClick={onClose}
          className={`w-full py-2 rounded font-bold transition-colors ${
            showRecord
              ? "mt-2 bg-neutral-700 hover:bg-neutral-600"
              : "mt-6 bg-green-600 hover:bg-green-700"
          }`}
        >
          Close
        </button>
      </div>
    </div>
  );
}
