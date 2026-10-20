"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  codeLanguages,
  itemResponseSchema,
  updateItemSchema,
  type CodeLanguage,
} from "@collab/shared";
import { apiRequest, errorMessage } from "@/lib/api-client";
import {
  itemsQueryKey,
  recordTreeNotification,
} from "@/components/tree/tree-utils";

export function LanguagePicker({
  projectId,
  itemId,
  language,
  editable,
  online,
}: {
  projectId: string;
  itemId: string;
  language: CodeLanguage;
  editable: boolean;
  online: boolean;
}) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: (value: string) =>
      apiRequest(
        `/api/projects/${projectId}/items/${itemId}`,
        itemResponseSchema,
        {
          method: "PATCH",
          body: updateItemSchema.parse({ action: "language", language: value }),
        },
      ),
    onSuccess: async ({ notificationPending }) => {
      recordTreeNotification(client, projectId, notificationPending);
      await client.invalidateQueries({ queryKey: itemsQueryKey(projectId) });
    },
  });
  return (
    <div className="w-full min-w-0 sm:w-auto">
      <label className="grid grid-cols-[4.5rem_minmax(0,1fr)] items-center gap-2 text-xs font-medium sm:flex">
        <span className="text-muted-foreground text-xs">Language</span>
        <select
          aria-label="Code language"
          className="h-7 w-full min-w-0 rounded-md border border-border bg-card px-2 text-xs font-mono text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-blue sm:w-36"
          value={language}
          disabled={!editable || !online || mutation.isPending}
          onChange={(event) => mutation.mutate(event.target.value)}
        >
          {codeLanguages.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {mutation.error && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {errorMessage(mutation.error)}
        </p>
      )}
    </div>
  );
}
