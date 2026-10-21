"use client";

import { useEffect, useState } from "react";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import { awarenessStateSchema, type RealtimeUser } from "@/lib/shared";

export function OnlineAvatars({
  provider,
  connected,
}: {
  provider: HocuspocusProvider;
  connected: boolean;
}) {
  const [users, setUsers] = useState<RealtimeUser[]>([]);
  useEffect(() => {
    const awareness = provider.awareness;
    if (!awareness) return;
    let active = true;
    let pending = false;
    function update() {
      if (pending) return;
      pending = true;
      // BlockNote can publish awareness while creating its editor during render.
      // Read a coalesced snapshot after that work finishes and before painting.
      queueMicrotask(() => {
        pending = false;
        if (!active) return;
        const unique = new Map<string, RealtimeUser>();
        for (const state of awareness?.getStates().values() ?? []) {
          const parsed = awarenessStateSchema.safeParse(state);
          if (parsed.success) unique.set(parsed.data.user.id, parsed.data.user);
        }
        const nextUsers = [...unique.values()].sort(
          (left, right) =>
            left.name.localeCompare(right.name) ||
            left.id.localeCompare(right.id),
        );
        setUsers((current) =>
          current.length === nextUsers.length &&
          current.every((user, index) => {
            const next = nextUsers[index];
            return (
              next &&
              user.id === next.id &&
              user.name === next.name &&
              user.color === next.color &&
              user.image === next.image
            );
          })
            ? current
            : nextUsers,
        );
      });
    }
    awareness.on("change", update);
    update();
    return () => {
      active = false;
      awareness.off("change", update);
    };
  }, [provider]);
  if (!connected)
    return (
      <p className="text-xs text-muted-foreground">Presence reconnecting</p>
    );
  return (
    <div
      className="flex items-center gap-2"
      aria-label={`${users.length} people on this page`}
    >
      <ul className="flex -space-x-2">
        {users.slice(0, 5).map((user) => (
          <li
            key={user.id}
            title={user.name}
            className="flex size-8 items-center justify-center rounded-full border-2 border-card text-[10px] font-semibold text-white"
            style={{ backgroundColor: user.color }}
          >
            <span aria-hidden="true">
              {user.name
                .split(/\s+/)
                .map((part) => part[0])
                .join("")
                .slice(0, 2)
                .toUpperCase()}
            </span>
            <span className="sr-only">{user.name}</span>
          </li>
        ))}
        {users.length > 5 && (
          <li className="flex size-8 items-center justify-center rounded-full border-2 border-card bg-border text-[10px] font-medium">
            +{users.length - 5}
          </li>
        )}
      </ul>
      <span className="text-xs text-muted-foreground">
        {users.length} online
      </span>
    </div>
  );
}
