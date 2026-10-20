"use client";

import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  itemResponseSchema,
  updateItemSchema,
  type TreeItem as ProjectItem,
} from "@collab/shared";
import { apiRequest, errorMessage, useOnline } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import {
  childrenOf,
  descendantsOf,
  itemsQueryKey,
  recordTreeNotification,
} from "./tree-utils";

export function ItemMoveDialog({
  projectId,
  item,
  items,
  onClose,
}: {
  projectId: string;
  item: ProjectItem;
  items: ProjectItem[];
  onClose: () => void;
}) {
  const online = useOnline();
  const queryClient = useQueryClient();
  const [parentId, setParentId] = useState(item.parentId ?? "");
  const [validationError, setValidationError] = useState<string | null>(null);
  const excluded = descendantsOf(items, item.id);
  const destinations = items.filter(
    (candidate) => candidate.type === "FOLDER" && !excluded.has(candidate.id),
  );
  const siblings = childrenOf(items, parentId || null).filter(
    (candidate) => candidate.id !== item.id,
  );
  const mutation = useMutation({
    mutationFn: (input: unknown) =>
      apiRequest(
        `/api/projects/${projectId}/items/${item.id}`,
        itemResponseSchema,
        { method: "PATCH", body: input },
      ),
    onSuccess: async ({ notificationPending }) => {
      recordTreeNotification(queryClient, projectId, notificationPending);
      await queryClient.invalidateQueries({
        queryKey: itemsQueryKey(projectId),
      });
      onClose();
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending || !online) return;
    const parsed = updateItemSchema.safeParse({
      action: "move",
      parentId: parentId || null,
      index: Number(new FormData(event.currentTarget).get("index")),
    });
    if (!parsed.success) {
      setValidationError(
        parsed.error.issues[0]?.message ?? "Choose a destination.",
      );
      return;
    }
    setValidationError(null);
    mutation.mutate(parsed.data);
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Move item"
      description="Choose a folder and position. Nested items move together."
    >
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="block text-xs font-semibold text-foreground mb-1.5">
            Destination folder
          </label>
          <select
            name="parentId"
            value={parentId}
            onChange={(event) => setParentId(event.target.value)}
            disabled={mutation.isPending}
            className="h-8.5 w-full rounded-md border border-border bg-card px-2.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue"
          >
            <option value="">Repository root</option>
            {destinations.map((candidate) => (
              <option value={candidate.id} key={candidate.id}>
                {candidate.title}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-foreground mb-1.5">
            Position
          </label>
          <select
            key={parentId}
            name="index"
            defaultValue={Math.min(item.order, siblings.length)}
            disabled={mutation.isPending}
            className="h-8.5 w-full rounded-md border border-border bg-card px-2.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue"
          >
            {siblings.map((sibling, index) => (
              <option key={sibling.id} value={index}>
                Before {sibling.title}
              </option>
            ))}
            <option value={siblings.length}>At the end</option>
          </select>
        </div>
        {(validationError || mutation.error) && (
          <p role="alert" className="rounded-md border border-destructive/20 bg-danger-soft p-2 text-xs text-destructive">
            {validationError ?? errorMessage(mutation.error)}
          </p>
        )}
        {!online && (
          <p role="status" className="text-xs text-warning">
            Reconnect to move this item.
          </p>
        )}
        <div className="flex justify-end gap-2 pt-3 border-t border-border">
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={mutation.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="submit"
            disabled={!online || mutation.isPending}
          >
            {mutation.isPending ? "Moving…" : "Move item"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
