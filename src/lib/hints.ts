import type { GuessResult } from "./game";
import { WORD_LENGTH } from "./game";
import { VALID_GUESSES } from "./words";

interface Constraints {
  correct: (string | null)[];
  present: Map<string, Set<number>>;
  absent: Set<string>;
}

function buildConstraints(guesses: GuessResult[]): Constraints {
  const correct: (string | null)[] = Array(WORD_LENGTH).fill(null);
  const present = new Map<string, Set<number>>();
  const absent = new Set<string>();
  const usedLetters = new Set<string>();

  for (const { word, results } of guesses) {
    for (let i = 0; i < WORD_LENGTH; i++) {
      const letter = word[i];
      if (results[i] === "correct") {
        correct[i] = letter;
        usedLetters.add(letter);
      } else if (results[i] === "present") {
        if (!present.has(letter)) present.set(letter, new Set());
        present.get(letter)!.add(i);
        usedLetters.add(letter);
      }
    }
  }

  for (const { word, results } of guesses) {
    for (let i = 0; i < WORD_LENGTH; i++) {
      if (results[i] === "absent" && !usedLetters.has(word[i])) {
        absent.add(word[i]);
      }
    }
  }

  return { correct, present, absent };
}

function matchesConstraints(word: string, c: Constraints): boolean {
  for (let i = 0; i < WORD_LENGTH; i++) {
    if (c.correct[i] && word[i] !== c.correct[i]) return false;
  }

  for (const [letter, positions] of c.present) {
    if (!word.includes(letter)) return false;
    for (const pos of positions) {
      if (word[pos] === letter) return false;
    }
  }

  for (const letter of c.absent) {
    if (word.includes(letter)) return false;
  }

  return true;
}

export function filterRemainingWords(guesses: GuessResult[]): string[] {
  if (guesses.length === 0) return [];
  const constraints = buildConstraints(guesses);
  const remaining: string[] = [];
  for (const word of VALID_GUESSES) {
    if (matchesConstraints(word, constraints)) {
      remaining.push(word);
    }
  }
  return remaining.sort();
}
