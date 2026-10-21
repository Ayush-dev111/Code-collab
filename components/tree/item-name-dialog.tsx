"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  createItemSchema,
  updateItemSchema,
  itemResponseSchema,
  codeLanguages,
  type TreeItem as ProjectItem,
} from "@/lib/shared";
import { apiRequest, errorMessage, useOnline } from "@/lib/api-client";
import { canLeaveSharedPage } from "@/lib/realtime-client";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { itemsQueryKey } from "./tree-utils";

export function ItemNameDialog({
  projectId,
  item,
  parentId = null,
  onClose,
}: {
  projectId: string;
  item?: ProjectItem;
  parentId?: string | null;
  onClose: () => void;
}) {
  const online = useOnline();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [validationError, setValidationError] = useState<string | null>(null);
  const [type, setType] = useState("PAGE");
  const mutation = useMutation({
    mutationFn: (input: unknown) =>
      apiRequest(
        `/api/projects/${projectId}/items${item ? `/${item.id}` : ""}`,
        itemResponseSchema,
        { method: item ? "PATCH" : "POST", body: input },
      ),
    onSuccess: async ({ item: savedItem }) => {
      await queryClient.invalidateQueries({
        queryKey: itemsQueryKey(projectId),
      });
      if (!item && savedItem.type !== "FOLDER" && canLeaveSharedPage())
        router.push(`/projects/${projectId}/${savedItem.id}`);
      else router.refresh();
      onClose();
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mutation.isPending || !online) return;
    const fields = new FormData(event.currentTarget);
    const input = item
      ? updateItemSchema.safeParse({
          action: "rename",
          title: fields.get("title"),
        })
      : createItemSchema.safeParse({
          title: fields.get("title"),
          type: fields.get("type"),
          parentId,
          ...(type === "CODE" ? { language: fields.get("language") } : {}),
        });
    if (!input.success) {
      setValidationError(input.error.issues[0]?.message ?? "Enter a title.");
      return;
    }
    setValidationError(null);
    mutation.mutate(input.data);
  }

  const error =
    validationError ?? (mutation.error ? errorMessage(mutation.error) : null);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={item ? "Rename item" : "Add a page, code file or folder"}
      description={
        item
          ? "Change the title for everyone in this project."
          : "Write together in pages and code files. Use folders to organize them."
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {!item && (
          <div>
            <label className="block text-xs font-semibold text-foreground mb-1.5">
              Type
            </label>
            <select
              name="type"
              value={type}
              onChange={(event) => setType(event.target.value)}
              className="h-8.5 w-full rounded-md border border-border bg-card px-2.5 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue"
              disabled={mutation.isPending}
            >
              <option value="PAGE">Page (Markdown / Rich Doc)</option>
              <option value="CODE">Code file</option>
              <option value="FOLDER">Folder</option>
            </select>
          </div>
        )}
        {!item && type === "CODE" && (
          <div>
            <label className="block text-xs font-semibold text-foreground mb-1.5">
              Language
            </label>
            <select
              name="language"
              defaultValue="javascript"
              className="h-8.5 w-full rounded-md border border-border bg-card px-2.5 text-xs font-mono text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue"
              disabled={mutation.isPending}
            >
              {codeLanguages.map((language) => (
                <option key={language.id} value={language.id}>
                  {language.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className="block text-xs font-semibold text-foreground mb-1.5">
            {type === "FOLDER" ? "Folder name" : "File name"}
          </label>
          <Input
            name="title"
            className="h-8.5 text-xs font-mono"
            placeholder={
              type === "FOLDER"
                ? "e.g. src"
                : type === "CODE"
                  ? "main.ts"
                  : "Overview.md"
            }
            defaultValue={item?.title ?? ""}
            required
            maxLength={120}
            disabled={mutation.isPending}
            autoFocus
          />
        </div>
        {error && (
          <p
            role="alert"
            className="rounded-md border border-destructive/20 bg-danger-soft p-2 text-xs text-destructive"
          >
            {error}
          </p>
        )}
        {!online && (
          <p role="status" className="text-xs text-warning">
            Reconnect to save this item.
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
            {mutation.isPending
              ? "Saving…"
              : item
                ? "Save name"
                : "Create file"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
