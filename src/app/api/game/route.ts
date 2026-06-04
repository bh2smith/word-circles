const API_URL = process.env.API_URL;

export async function GET(req: Request) {
  if (!API_URL) {
    return new Response("API_URL not configured", { status: 503 });
  }
  const search = new URL(req.url).search;
  const res = await fetch(`${API_URL}/api/game${search}`);
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
