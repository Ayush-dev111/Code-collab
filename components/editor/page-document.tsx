"use client";

import { useQueryClient, useQuery } from "@tanstack/react-query";
import {
  hasMinimumRole,
  itemsResponseSchema,
  type RealtimeUser,
  type Role,
  type TreeItem,
} from "@/lib/shared";
import { apiRequest, useOnline } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { OnlineAvatars } from "@/components/presence/online-avatars";
import { itemsQueryKey } from "@/components/tree/tree-utils";
import { useDocumentSession } from "./use-document-session";
import { CollaborativeEditor } from "./collaborative-editor";
import { useEffect } from "react";
import { Icon } from "@/components/ui/icon";

export default function PageDocument({
  projectId,
  initialItem,
  role,
  user,
}: {
  projectId: string;
  initialItem: TreeItem;
  role: Role;
  user: RealtimeUser;
}) {
  const online = useOnline();
  const session = useDocumentSession(initialItem.id);
  const client = useQueryClient();
  const items = useQuery({
    queryKey: itemsQueryKey(projectId),
    queryFn: ({ signal }) =>
      apiRequest(`/api/projects/${projectId}/items`, itemsResponseSchema, {
        signal,
      }),
  });
  const item =
    items.data?.items.find((candidate) => candidate.id === initialItem.id) ??
    initialItem;
  useEffect(() => {
    if (!session.provider) return;
    const refreshRole = () =>
      void client.invalidateQueries({ queryKey: ["project", projectId] });
    session.provider.on("authenticated", refreshRole);
    session.provider.on("authenticationFailed", refreshRole);
    return () => {
      session.provider?.off("authenticated", refreshRole);
      session.provider?.off("authenticationFailed", refreshRole);
    };
  }, [client, projectId, session.provider]);
  const editable = hasMinimumRole(role, "EDITOR") && session.writable;
  return (
    <section
      aria-label="Collaborative page"
      className="min-h-full min-w-0 rounded-md border border-border bg-card p-4 sm:p-6 shadow-xs"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4 border-b border-border pb-4">
        <div className="min-w-0">
          <div className="mb-1.5 flex items-center gap-2 text-xs font-mono text-muted-foreground">
            <span className="flex items-center gap-1 rounded border border-border bg-secondary px-1.5 py-0.5 font-medium">
              <Icon name="gitBranch" className="size-3" />
              main
            </span>
            <span>/</span>
            <span className="text-foreground font-semibold">
              {item.title}.md
            </span>
          </div>
          <h2 className="break-words font-mono text-lg font-semibold tracking-tight">
            {item.title}
          </h2>
          <p
            role="status"
            aria-live="polite"
            className="mt-1 text-xs text-muted-foreground"
          >
            {!session.synced
              ? "Loading shared document..."
              : !online || !session.connected
                ? "Offline. Pending edits stay in this tab and sync after reconnecting."
                : session.wasWritable && session.unsyncedChanges > 0
                  ? "Syncing changes..."
                  : "All changes synced"}
          </p>
        </div>
        {session.provider && (
          <OnlineAvatars
            provider={session.provider}
            connected={session.connected}
          />
        )}
      </div>
      {session.error && (
        <div
          role="alert"
          className="mb-5 rounded-lg border border-warning/20 bg-warning-soft p-4 text-sm text-warning"
        >
          <p>{session.error}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            disabled={!online}
            onClick={session.reconnect}
          >
            Reconnect document
          </Button>
        </div>
      )}
      {!session.synced && !session.error && (
        <div role="status" className="animate-pulse space-y-4 py-6">
          <div className="h-5 w-1/2 rounded bg-secondary" />
          <div className="h-4 w-5/6 rounded bg-secondary" />
          <div className="h-4 w-3/4 rounded bg-secondary" />
        </div>
      )}
      {session.synced && session.provider && (
        <>
          {!editable && (
            <p className="mb-5 rounded-lg bg-secondary px-4 py-3 text-sm text-muted-foreground">
              You have read-only access to this page.
            </p>
          )}
          {editable && (
            <p className="mb-5 text-xs text-muted-foreground">
              Type / to add headings, lists, to-do items, code, images and
              tables.
            </p>
          )}
          <CollaborativeEditor
            provider={session.provider}
            user={user}
            projectId={projectId}
            itemId={initialItem.id}
            title={item.title}
            editable={editable}
          />
        </>
      )}
    </section>
  );
}
