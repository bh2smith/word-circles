import { NextRequest } from "next/server";

const API_URL = process.env.API_URL;

export async function POST(req: NextRequest) {
  if (!API_URL) {
    return new Response("API_URL not configured", { status: 503 });
  }
  const body = await req.text();
  const res = await fetch(`${API_URL}/api/guess`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
