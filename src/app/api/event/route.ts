const API_URL = process.env.API_URL;

export async function POST(req: Request) {
  if (!API_URL) return new Response(null, { status: 204 });
  const body = await req.text();
  const res = await fetch(`${API_URL}/api/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return new Response(null, { status: res.status });
}
