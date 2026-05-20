import { NextRequest, NextResponse } from "next/server";
import { isValidGuess, MAX_GUESSES, WORD_LENGTH } from "@/lib/game";
import { evaluateGuess, getAnswer } from "@/lib/game.server";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { guess, gameId, guessNumber } = body;

  if (typeof guess !== "string" || typeof gameId !== "number") {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  const normalized = guess.toLowerCase();

  if (normalized.length !== WORD_LENGTH || !/^[a-z]+$/.test(normalized)) {
    return NextResponse.json(
      { error: "Guess must be 5 letters" },
      { status: 400 },
    );
  }

  if (!isValidGuess(normalized)) {
    return NextResponse.json({ error: "Not in word list" }, { status: 400 });
  }

  if (
    typeof guessNumber !== "number" ||
    guessNumber < 0 ||
    guessNumber >= MAX_GUESSES
  ) {
    return NextResponse.json(
      { error: "Invalid guess number" },
      { status: 400 },
    );
  }

  const answer = getAnswer(gameId);
  const results = evaluateGuess(normalized, answer);
  const won = results.every((r) => r === "correct");
  const gameOver = won || guessNumber >= MAX_GUESSES - 1;

  return NextResponse.json({
    guess: normalized,
    results,
    won,
    gameOver,
    ...(gameOver ? { answer } : {}),
  });
}
