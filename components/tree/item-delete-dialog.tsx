"use client";

import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  deleteItemsResponseSchema,
  emptyInputSchema,
  type TreeItem,
} from "@/lib/shared";
import { apiRequest, errorMessage, useOnline } from "@/lib/api-client";
import { canLeaveSharedPage } from "@/lib/realtime-client";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { itemsQueryKey } from "./tree-utils";

export function ItemDeleteDialog({
  projectId,
  item,
  selectedItemId,
  onClose,
}: {
  projectId: string;
  item: TreeItem;
  selectedItemId?: string | undefined;
  onClose: () => void;
}) {
  const router = useRouter();
  const online = useOnline();
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      apiRequest(
        `/api/projects/${projectId}/items/${item.id}`,
        deleteItemsResponseSchema,
        { method: "DELETE", body: emptyInputSchema.parse({}) },
      ),
    onSuccess: async ({ deletedIds }) => {
      await client.invalidateQueries({ queryKey: itemsQueryKey(projectId) });
      if (
        selectedItemId &&
        deletedIds.includes(selectedItemId) &&
        canLeaveSharedPage()
      )
        router.replace(`/projects/${projectId}`);
      else router.refresh();
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Delete ${item.title}?`}
      description="This deletes the item and everything nested inside it. This cannot be undone."
    >
      {mutation.error && (
        <p
          role="alert"
          className="mb-4 rounded-md border border-destructive/20 bg-danger-soft p-2 text-xs text-destructive"
        >
          {errorMessage(mutation.error)}
        </p>
      )}
      {!online && (
        <p role="status" className="mb-4 text-xs text-warning">
          Reconnect to delete this item.
        </p>
      )}
      <div className="flex justify-end gap-2 pt-3 border-t border-border">
        <Button
          variant="outline"
          size="sm"
          disabled={mutation.isPending}
          onClick={onClose}
        >
          Cancel
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={!online || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? "Deleting…" : "Delete"}
        </Button>
      </div>
    </Dialog>
  );
}
