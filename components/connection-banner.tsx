"use client";

import { useOnline } from "@/lib/api-client";

export function ConnectionBanner() {
  if (useOnline()) return null;
  return (
    <div
      role="status"
      className="border-b border-warning/20 bg-warning-soft px-6 py-3 text-center text-sm text-warning"
    >
      You’re offline. Keep this tab open; your document edits will sync when you
      reconnect.
    </div>
  );
}
