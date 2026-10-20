"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  codeFontSizeSchema,
  codeStdinSchema,
  hasMinimumRole,
  itemsResponseSchema,
  type RealtimeUser,
  type Role,
  type TreeItem,
} from "@collab/shared";
import { apiRequest, useOnline } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { OnlineAvatars } from "@/components/presence/online-avatars";
import { itemsQueryKey } from "@/components/tree/tree-utils";
import { useDocumentSession } from "@/components/editor/use-document-session";
import { LanguagePicker } from "./language-picker";
import { EditorSettings, type EditorTheme } from "./editor-settings";
import { MonacoDocument } from "./monaco-document";
import { RunPanel } from "./run-panel";
import { useTheme } from "@/components/theme-provider";
import { Icon } from "@/components/ui/icon";

function preference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
export default function CodeDocument({
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
  const client = useQueryClient();
  const session = useDocumentSession(projectId, initialItem.id);
  const { theme: appTheme } = useTheme();
  const [editorTheme, setEditorTheme] = useState<EditorTheme>(() => {
    const saved = preference("collab:code:theme");
    return saved === "light" || saved === "vs-dark" ? saved : "system";
  });
  const theme =
    editorTheme === "system"
      ? appTheme === "dark"
        ? "vs-dark"
        : "light"
      : editorTheme;
  const [fontSize, setFontSize] = useState(() => {
    const parsed = codeFontSizeSchema.safeParse(
      preference("collab:code:font-size"),
    );
    return parsed.success ? parsed.data : 14;
  });
  const [stdin, setStdin] = useState("");
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
    try {
      localStorage.setItem("collab:code:theme", editorTheme);
      localStorage.setItem("collab:code:font-size", String(fontSize));
    } catch {
      /* Editing remains available when browser storage is disabled. */
    }
  }, [fontSize, editorTheme]);
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
      aria-label="Collaborative code file"
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
            <span className="text-foreground font-semibold">{item.title}</span>
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
              ? "Loading shared code..."
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
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-secondary/40 px-3 py-2">
        <LanguagePicker
          projectId={projectId}
          itemId={item.id}
          language={item.language ?? "javascript"}
          editable={editable}
          online={online}
        />
        <EditorSettings
          theme={editorTheme}
          fontSize={fontSize}
          onTheme={setEditorTheme}
          onFontSize={setFontSize}
        />
      </div>
      {session.synced && session.provider ? (
        <>
          {!editable && (
            <p className="mb-4 rounded-md border border-border bg-secondary px-3 py-2 text-xs text-muted-foreground">
              You have read-only access to this code file.
            </p>
          )}
          <MonacoDocument
            provider={session.provider}
            user={user}
            language={item.language ?? "javascript"}
            editable={editable}
            theme={theme}
            fontSize={fontSize}
          />
        </>
      ) : (
        !session.error && (
          <p role="status" className="py-12 text-sm text-muted-foreground">
            Connecting to shared code...
          </p>
        )
      )}
      <label className="mt-6 block text-xs font-semibold">
        Standard input (stdin)
        <textarea
          aria-label="Standard input"
          className="mt-2 min-h-24 w-full resize-y rounded-md border border-border bg-card p-2.5 font-mono text-xs transition-colors focus-visible:border-blue focus-visible:ring-1 focus-visible:ring-blue/30 focus-visible:outline-none shadow-xs"
          placeholder="Input for your next code run"
          value={stdin}
          maxLength={16 * 1024}
          disabled={!editable}
          onChange={(event) => {
            const input = codeStdinSchema.safeParse(event.target.value);
            if (input.success) setStdin(input.data);
          }}
        />
      </label>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">
        Input stays in this tab until you run the file. Run output is shared
        with the project.
      </p>
      <RunPanel
        projectId={projectId}
        itemId={item.id}
        language={item.language ?? "javascript"}
        stdin={stdin}
        canEdit={hasMinimumRole(role, "EDITOR")}
        ready={
          editable &&
          session.synced &&
          session.connected &&
          session.unsyncedChanges === 0
        }
        online={online}
        sourceCode={() =>
          session.provider?.document.getText("code").toString() ?? ""
        }
      />
    </section>
  );
}
