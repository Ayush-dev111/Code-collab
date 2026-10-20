"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { itemsResponseSchema } from "@collab/shared";
import { apiRequest, useOnline } from "@/lib/api-client";
import type { ProjectRealtime } from "@/lib/realtime-client";
import { itemsQueryKey } from "@/components/tree/tree-utils";

export function ProjectOnlineList({
  projectId,
  realtime,
}: {
  projectId: string;
  realtime: ProjectRealtime;
}) {
  const online = useOnline();
  const items = useQuery({
    queryKey: itemsQueryKey(projectId),
    queryFn: ({ signal }) =>
      apiRequest(`/api/projects/${projectId}/items`, itemsResponseSchema, {
        signal,
      }),
  });
  return (
    <section aria-labelledby="online-title">
      <div className="flex items-center justify-between gap-2">
        <h2
          id="online-title"
          className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground"
        >
          Online now
        </h2>
        {realtime.connected && (
          <span className="text-xs text-muted-foreground">
            {realtime.users.length}
          </span>
        )}
      </div>
      {!online || !realtime.connected ? (
        <p
          role="status"
          className="mt-3 text-xs leading-5 text-muted-foreground"
        >
          {!online
            ? "Offline. Presence will return when you reconnect."
            : realtime.error
              ? "Live presence is unavailable. Use Reconnect live updates above."
              : "Connecting live presence..."}
        </p>
      ) : (
        <ul aria-label="Online project members" className="mt-4 space-y-4">
          {realtime.users.map(({ user, itemIds, viewingOverview }) => (
            <li key={user.id} className="flex items-start gap-2.5">
              <span
                aria-hidden="true"
                className="relative flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-medium text-white"
                style={{ backgroundColor: user.color }}
              >
                {user.name.slice(0, 1).toUpperCase()}
                <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-card bg-emerald-500" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium" title={user.name}>
                  {user.name}
                </p>
                <ul className="mt-0.5 space-y-1 text-xs text-muted-foreground">
                  {viewingOverview && (
                    <li>
                      <Link
                        href={`/projects/${projectId}`}
                        className="hover:text-primary"
                      >
                        Project overview
                      </Link>
                    </li>
                  )}
                  {itemIds.map((itemId) => {
                    const item = items.data?.items.find(
                      (page) => page.id === itemId,
                    );
                    return (
                      <li key={itemId}>
                        <Link
                          href={`/projects/${projectId}/${itemId}`}
                          className="block truncate hover:text-primary"
                          title={item?.title ?? "Viewing a page"}
                        >
                          {item?.title ?? "Viewing a page"}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
