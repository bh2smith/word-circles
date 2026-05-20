import { NextResponse } from "next/server";
import { getGameId } from "@/lib/game";

export async function GET() {
  return NextResponse.json({ gameId: getGameId() });
}
