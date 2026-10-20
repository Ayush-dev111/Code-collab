"use client";

import { useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  executableLanguageSchema,
  runHistoryResponseSchema,
  runInputSchema,
  runResponseSchema,
} from "@collab/shared";
import { apiRequest, errorMessage } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { RunOutput } from "./run-output";

export function RunPanel({
  projectId,
  itemId,
  language,
  stdin,
  canEdit,
  ready,
  online,
  sourceCode,
}: {
  projectId: string;
  itemId: string;
  language: string;
  stdin: string;
  canEdit: boolean;
  ready: boolean;
  online: boolean;
  sourceCode: () => string;
}) {
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const history = useInfiniteQuery({
    queryKey: ["runs", projectId, itemId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) =>
      apiRequest(
        `/api/projects/${projectId}/items/${itemId}/runs${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ""}`,
        runHistoryResponseSchema,
        { signal },
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: (query) => {
      if (!online) return false;
      const hasRunning = query.state.data?.pages.some((page) =>
        page.runs.some((run) => run.status === "RUNNING"),
      );
      return hasRunning ? 4000 : false;
    },
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: () =>
      apiRequest("/api/run", runResponseSchema, {
        method: "POST",
        body: runInputSchema.parse({
          projectId,
          itemId,
          language,
          stdin,
          sourceCode: sourceCode(),
        }),
      }),
    onSettled: () =>
      void client.invalidateQueries({ queryKey: ["runs", projectId, itemId] }),
  });
  const rows = history.data?.pages.flatMap((page) => page.runs) ?? [];
  const running = rows.some((run) => run.status === "RUNNING");
  const latest = rows[0] ?? mutation.data?.run;
  const selected = rows.find((run) => run.id === selectedId) ?? latest;
  const supported = executableLanguageSchema.safeParse(language).success;
  return (
    <section
      aria-label="Code execution"
      className="mt-6 rounded-md border border-border bg-card p-4 shadow-xs"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
        <div className="flex items-center gap-2">
          <Icon name="terminal" className="size-4 text-muted-foreground" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Execution Output</h3>
        </div>
        {canEdit && (
          <Button
            size="sm"
            disabled={
              !online || !ready || !supported || running || mutation.isPending
            }
            onClick={() => {
              setSelectedId(null);
              mutation.mutate();
            }}
          >
            <Icon name="play" className="size-3" />
            <span>{running || mutation.isPending ? "Running…" : "Run"}</span>
          </Button>
        )}
      </div>
      {!supported && (
        <p className="mb-4 text-xs text-muted-foreground">
          Execution supports Python, JavaScript, C++ and Java. Choose one of
          these languages to run the file.
        </p>
      )}
      {canEdit && !ready && online && (
        <p className="mb-4 text-xs text-muted-foreground">
          Wait for your code changes to sync before running.
        </p>
      )}
      {!online && (
        <p role="status" className="mb-4 text-xs text-warning">
          Reconnect to run code and refresh output.
        </p>
      )}
      {mutation.isError && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {errorMessage(mutation.error)}
        </p>
      )}
      {mutation.data?.notificationPending && (
        <p role="status" className="mb-4 text-xs text-warning">
          Live output updates are delayed. Collaborators will recover the result
          from history.
        </p>
      )}
      {history.isPending ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading run history...
        </p>
      ) : history.isError ? (
        <div role="alert" className="mb-4 text-sm text-destructive">
          <p>{errorMessage(history.error)}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            disabled={!online || history.isFetching}
            onClick={() => void history.refetch()}
          >
            Retry history
          </Button>
        </div>
      ) : (
        <RunOutput run={selected} />
      )}
      {rows.length > 0 && (
        <details className="mt-5 border-t pt-4">
          <summary className="cursor-pointer text-xs font-medium">
            Run history ({rows.length})
          </summary>
          <ul className="mt-3 space-y-2" aria-label="Run history">
            {rows.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(run.id)}
                  aria-pressed={selected?.id === run.id}
                  className="flex w-full flex-wrap justify-between gap-2 rounded-lg border p-3 text-left text-xs hover:bg-secondary"
                >
                  <span>
                    {run.userName} · {run.language} · {run.statusLabel}
                  </span>
                  <time dateTime={run.createdAt}>
                    {new Date(run.createdAt).toLocaleString()}
                  </time>
                </button>
              </li>
            ))}
          </ul>
          {history.hasNextPage && (
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              disabled={!online || history.isFetchingNextPage}
              onClick={() => void history.fetchNextPage()}
            >
              Load older runs
            </Button>
          )}
        </details>
      )}
    </section>
  );
}
