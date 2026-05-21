import { NextRequest } from "next/server";

const API_URL = process.env.API_URL;

export async function GET(req: NextRequest) {
  if (!API_URL) {
    return new Response("API_URL not configured", { status: 503 });
  }
  const params = req.nextUrl.searchParams.toString();
  const url = `${API_URL}/api/leaderboard${params ? `?${params}` : ""}`;
  const res = await fetch(url);
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
