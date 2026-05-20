import { ANSWERS, VALID_GUESSES } from "./words";

export const WORD_LENGTH = 5;
export const MAX_GUESSES = 6;

export type LetterResult = "correct" | "present" | "absent";

export interface GuessResult {
  word: string;
  results: LetterResult[];
}

export interface GameState {
  gameId: number;
  guesses: GuessResult[];
  status: "playing" | "won" | "lost";
  answer?: string; // only revealed when game is over
}

// Epoch: Jan 1, 2025 — game number increments daily
const EPOCH = new Date("2025-01-01T00:00:00Z");

export function getGameId(date: Date = new Date()): number {
  const diff = date.getTime() - EPOCH.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

function hashGameId(gameId: number): number {
  let h = Math.imul(gameId, 2654435761);
  h = Math.imul((h >>> 16) ^ h, 0x45d9f3b);
  h = (h >>> 16) ^ h;
  return h >>> 0;
}

export function getAnswer(gameId: number): string {
  const index = hashGameId(gameId) % ANSWERS.length;
  return ANSWERS[index];
}

export function isValidGuess(word: string): boolean {
  return word.length === WORD_LENGTH && VALID_GUESSES.has(word.toLowerCase());
}

export function evaluateGuess(guess: string, answer: string): LetterResult[] {
  const g = guess.toLowerCase().split("");
  const a = answer.toLowerCase().split("");
  const result: LetterResult[] = Array(WORD_LENGTH).fill("absent");
  const answerUsed = Array(WORD_LENGTH).fill(false);

  // First pass: mark correct positions
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (g[i] === a[i]) {
      result[i] = "correct";
      answerUsed[i] = true;
    }
  }

  // Second pass: mark present (wrong position)
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (result[i] === "correct") continue;
    for (let j = 0; j < WORD_LENGTH; j++) {
      if (!answerUsed[j] && g[i] === a[j]) {
        result[i] = "present";
        answerUsed[j] = true;
        break;
      }
    }
  }

  return result;
}
