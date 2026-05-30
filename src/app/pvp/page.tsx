import PvpGame from "@/components/PvpGame";

export default function PvpPage() {
  // No build-time gate: PvpGame reads the backend's /api/config at runtime and
  // shows "PvP isn't available right now" when pvpEnabled is false, so a direct
  // visit while PvP is dark degrades gracefully instead of redirecting.
  return (
    <main className="flex-1 flex items-center justify-center py-4">
      <PvpGame />
    </main>
  );
}
