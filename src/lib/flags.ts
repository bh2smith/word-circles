// Frontend feature flags.
//
// PvP ships dark: the entry point (mode nav + /pvp route) stays hidden until
// the backend serving the PvP endpoints (/api/games, /api/config lobby params,
// transcript) is rolled out. With the flag off the app is the daily game only,
// fully compatible with the currently deployed backend. Flip
// NEXT_PUBLIC_PVP_ENABLED=true in Vercel once that backend is live.
//
// Note this is just the rollout gate — PvpGame still independently checks the
// backend's /api/config (pvpEnabled + lobby params) before any matchmaking, so
// a direct /pvp visit can't fire against an unready backend either.
export const PVP_ENABLED = process.env.NEXT_PUBLIC_PVP_ENABLED === "true";
