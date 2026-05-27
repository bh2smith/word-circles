import { redirect } from "next/navigation";
import PvpGame from "@/components/PvpGame";
import { PVP_ENABLED } from "@/lib/flags";

export default function PvpPage() {
  // Guard the route too, so a direct visit doesn't reach PvP while it's dark.
  if (!PVP_ENABLED) redirect("/");
  return (
    <main className="flex-1 flex items-center justify-center py-4">
      <PvpGame />
    </main>
  );
}
