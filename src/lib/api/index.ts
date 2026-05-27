// Friendly aliases over the auto-generated OpenAPI schema types.
//
// `types.ts` is generated from the backend spec snapshot `openapi.json` via
// `bun run gen:api` (see the Makefile `openapi` target to refresh the snapshot
// from the running backend). Import request/response shapes from here so the
// frontend tracks the backend contract instead of hand-maintained interfaces.
import type { components } from "./types";

type Schemas = components["schemas"];

export type GameResponse = Schemas["GameResponse"];
export type GuessRequest = Schemas["GuessRequest"];
export type GuessResponse = Schemas["GuessResponse"];
export type ErrorResponse = Schemas["ErrorResponse"];
export type LetterResult = Schemas["LetterResult"];
export type LeaderboardEntry = Schemas["LeaderboardEntry"];
export type DailyResult = Schemas["DailyResult"];
export type ContractConfig = Schemas["ContractConfig"];
export type PvpGameResponse = Schemas["PvpGameResponse"];
export type PvpPlayerStatus = Schemas["PvpPlayerStatus"];
export type PvpTranscript = Schemas["PvpTranscript"];
export type PvpTranscriptPlayer = Schemas["PvpTranscriptPlayer"];
export type PvpTranscriptGuess = Schemas["PvpTranscriptGuess"];
