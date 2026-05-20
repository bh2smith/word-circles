import { VALID_GUESSES } from "./words";

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
  answer?: string;
}

const EPOCH = new Date("2025-01-01T00:00:00Z");

export function getGameId(date: Date = new Date()): number {
  const diff = date.getTime() - EPOCH.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

export function isValidGuess(word: string): boolean {
  return word.length === WORD_LENGTH && VALID_GUESSES.has(word.toLowerCase());
}
