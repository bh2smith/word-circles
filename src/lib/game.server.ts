import "server-only";

import { ANSWERS } from "./words.server";
import { WORD_LENGTH } from "./game";
import type { LetterResult } from "./game";

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

export function evaluateGuess(guess: string, answer: string): LetterResult[] {
  const g = guess.toLowerCase().split("");
  const a = answer.toLowerCase().split("");
  const result: LetterResult[] = Array(WORD_LENGTH).fill("absent");
  const answerUsed = Array(WORD_LENGTH).fill(false);

  for (let i = 0; i < WORD_LENGTH; i++) {
    if (g[i] === a[i]) {
      result[i] = "correct";
      answerUsed[i] = true;
    }
  }

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
