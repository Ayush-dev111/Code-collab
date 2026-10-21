"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { hasMinimumRole, itemsResponseSchema, type Role } from "@/lib/shared";
import {
  apiRequest,
  ApiClientError,
  errorMessage,
  useOnline,
} from "@/lib/api-client";
import {
  canLeaveSharedPage,
  type ProjectRealtime,
} from "@/lib/realtime-client";
import { Button } from "@/components/ui/button";
import { ItemNameDialog } from "./item-name-dialog";
import { ItemMoveDialog } from "./item-move-dialog";
import { ItemDeleteDialog } from "./item-delete-dialog";
import { TreeRows, type TreeAction } from "./tree-row";
import { itemsQueryKey } from "./tree-utils";
import { Icon } from "@/components/ui/icon";

export function ProjectTree({
  projectId,
  role,
  selectedItemId,
  realtime,
  onSelect,
}: {
  projectId: string;
  role: Role;
  selectedItemId?: string | undefined;
  realtime: ProjectRealtime;
  onSelect: () => void;
}) {
  const router = useRouter();
  const online = useOnline();
  const [action, setAction] = useState<TreeAction | "create" | null>(null);
  const editable = hasMinimumRole(role, "EDITOR");
  const query = useQuery({
    queryKey: itemsQueryKey(projectId),
    queryFn: ({ signal }) =>
      apiRequest(`/api/projects/${projectId}/items`, itemsResponseSchema, {
        signal,
      }),
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
  const items = query.data?.items ?? [];
  const denied =
    query.error instanceof ApiClientError &&
    [401, 403].includes(query.error.status);
  useEffect(() => {
    if (
      selectedItemId &&
      query.data &&
      !query.data.items.some((item) => item.id === selectedItemId) &&
      canLeaveSharedPage()
    )
      router.replace(`/projects/${projectId}`);
  }, [projectId, query.data, router, selectedItemId]);
  return (
    <section aria-labelledby="pages-title" className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <h2
          id="pages-title"
          className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground"
        >
          Files & pages
        </h2>
        {editable && (
          <Button
            variant="ghost"
            size="sm"
            disabled={!online || denied}
            onClick={() => setAction("create")}
            aria-label="Add page, code file or folder"
          >
            <Icon name="plus" />
          </Button>
        )}
      </div>
      <p role="status" className="mb-3 mt-1 text-[11px] text-muted-foreground">
        {!online
          ? "Offline - showing saved sidebar"
          : realtime.connected
            ? "Live sidebar updates"
            : "Connecting live updates..."}
      </p>
      {query.isPending && (
        <p role="status" className="py-4 text-sm text-muted-foreground">
          Loading pages...
        </p>
      )}
      {query.isError && (
        <div role="alert" className="mb-3 space-y-2 text-xs text-destructive">
          <p>{errorMessage(query.error)}</p>
          <Button
            size="sm"
            variant="outline"
            disabled={!online || query.isFetching}
            onClick={() => void query.refetch()}
          >
            Retry pages
          </Button>
        </div>
      )}
      {realtime.error && !denied && (
        <div role="alert" className="mb-3 space-y-2 text-xs text-warning">
          <p>{realtime.error}</p>
          <Button
            variant="outline"
            size="sm"
            disabled={!online}
            onClick={realtime.reconnect}
          >
            Reconnect live updates
          </Button>
        </div>
      )}
      {!denied && items.length > 0 && (
        <TreeRows
          projectId={projectId}
          items={items}
          selectedItemId={selectedItemId}
          editable={editable}
          online={online}
          onAction={setAction}
          onSelect={onSelect}
        />
      )}
      {query.isSuccess && items.length === 0 && (
        <p className="py-3 text-xs leading-6 text-muted-foreground">
          {editable
            ? "Add your first page to start writing together."
            : "This project has no pages yet."}
        </p>
      )}
      {editable && (action === "create" || action?.action === "create") && (
        <ItemNameDialog
          projectId={projectId}
          parentId={typeof action === "object" ? action?.item.id : null}
          onClose={() => setAction(null)}
        />
      )}
      {editable &&
        typeof action === "object" &&
        action?.action === "rename" && (
          <ItemNameDialog
            projectId={projectId}
            item={action.item}
            onClose={() => setAction(null)}
          />
        )}
      {editable && typeof action === "object" && action?.action === "move" && (
        <ItemMoveDialog
          projectId={projectId}
          item={action.item}
          items={items}
          onClose={() => setAction(null)}
        />
      )}
      {editable &&
        typeof action === "object" &&
        action?.action === "delete" && (
          <ItemDeleteDialog
            projectId={projectId}
            item={action.item}
            selectedItemId={selectedItemId}
            onClose={() => setAction(null)}
          />
        )}
    </section>
  );
}
