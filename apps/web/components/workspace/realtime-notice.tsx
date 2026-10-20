"use client";
import { useOnline } from "@/lib/api-client";
import type { ProjectRealtime } from "@/lib/realtime-client";
import { Button } from "@/components/ui/button";

export function RealtimeNotice({ realtime }: { realtime: ProjectRealtime }) {
  const online = useOnline();
  if (!online || realtime.connected) return null;
  return (
    <div
      role="status"
      aria-label="Project connection status"
      className="flex flex-wrap items-center justify-between gap-3 border-b border-warning/20 bg-warning-soft px-6 py-3 text-sm text-warning"
    >
      <p>
        {realtime.error
          ? "Live updates are unavailable. Keep this tab open and reconnect to restore them."
          : "Reconnecting to live updates…"}
      </p>
      {realtime.error && (
        <Button variant="outline" size="sm" onClick={realtime.reconnect}>
          Reconnect
        </Button>
      )}
    </div>
  );
}
