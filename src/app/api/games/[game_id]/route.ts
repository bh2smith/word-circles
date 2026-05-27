import { NextRequest } from "next/server";

const API_URL = process.env.API_URL;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ game_id: string }> },
) {
  if (!API_URL) {
    return new Response("API_URL not configured", { status: 503 });
  }
  const { game_id } = await params;
  const res = await fetch(
    `${API_URL}/api/games/${encodeURIComponent(game_id)}`,
  );
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
