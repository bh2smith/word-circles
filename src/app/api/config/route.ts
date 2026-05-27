const API_URL = process.env.API_URL;

export async function GET() {
  if (!API_URL) {
    return new Response("API_URL not configured", { status: 503 });
  }
  const res = await fetch(`${API_URL}/api/config`);
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": "application/json" },
  });
}
