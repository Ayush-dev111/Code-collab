"use client";

import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider, WebSocketStatus } from "@hocuspocus/provider";
import { realtimeDocumentNameSchema } from "@/lib/shared";
import { useProject } from "@/components/workspace/project-context";

type DocumentState = {
  provider: HocuspocusProvider | null;
  connected: boolean;
  synced: boolean;
  writable: boolean;
  wasWritable: boolean;
  unsyncedChanges: number;
  error: string | null;
};
const initialState: DocumentState = {
  provider: null,
  connected: false,
  synced: false,
  writable: false,
  wasWritable: false,
  unsyncedChanges: 0,
  error: null,
};

const UNSYNCED_WARNING =
  "This document has changes waiting to sync. Leave and discard those pending changes?";

// Opens one Yjs document on the project's shared WebSocket. Access is checked
// by the server with the session cookie when the document is attached.
export function useDocumentSession(itemId: string) {
  const { documentSocket } = useProject();
  const [state, setState] = useState<DocumentState>(initialState);
  const [attempt, setAttempt] = useState(0);
  const providerRef = useRef<HocuspocusProvider | null>(null);
  useEffect(() => {
    let active = true;
    let wasWritable = false;
    const socket = documentSocket();
    const document = new Y.Doc();
    function patch(update: Partial<DocumentState>) {
      if (active) setState((current) => ({ ...current, ...update }));
    }
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: realtimeDocumentNameSchema.parse(`item:${itemId}`),
      document,
      // Gives each provider its own channel on the shared socket. Without it,
      // closing a provider and reopening the same document (page switches,
      // React's development double mount) mixes their messages and the new
      // one never syncs.
      sessionAwareness: true,
      // The server authenticates with the session cookie; this value is unused.
      token: "session",
      onStatus: ({ status }) =>
        patch({ connected: status === WebSocketStatus.Connected }),
      onSynced: ({ state: synced }) => {
        if (synced) patch({ synced: true });
      },
      onAuthenticated: ({ scope }) => {
        wasWritable ||= scope === "read-write";
        patch({ writable: scope === "read-write", wasWritable, error: null });
      },
      onAuthenticationFailed: ({ reason }) =>
        patch({
          writable: false,
          error:
            reason ||
            "Your access to this document could not be verified. Reconnect to try again.",
        }),
      onUnsyncedChanges: ({ number }) => patch({ unsyncedChanges: number }),
    });
    provider.attach();
    void socket.connect();
    providerRef.current = provider;
    patch({
      ...initialState,
      provider,
      connected: socket.status === WebSocketStatus.Connected,
    });

    const hasPendingEdits = () => wasWritable && provider.hasUnsyncedChanges;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (hasPendingEdits()) event.preventDefault();
    };
    const beforeNavigate = (event: MouseEvent) => {
      if (
        !hasPendingEdits() ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const target =
        event.target instanceof Element
          ? event.target.closest("a[href]")
          : null;
      if (
        !(target instanceof HTMLAnchorElement) ||
        target.target === "_blank" ||
        target.href === window.location.href
      )
        return;
      if (!window.confirm(UNSYNCED_WARNING)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const beforeProgrammaticNavigate = (event: Event) => {
      if (hasPendingEdits() && !window.confirm(UNSYNCED_WARNING))
        event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("click", beforeNavigate, true);
    window.addEventListener(
      "collab:before-navigation",
      beforeProgrammaticNavigate,
    );
    return () => {
      active = false;
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("click", beforeNavigate, true);
      window.removeEventListener(
        "collab:before-navigation",
        beforeProgrammaticNavigate,
      );
      providerRef.current = null;
      provider.destroy();
      document.destroy();
    };
  }, [attempt, documentSocket, itemId]);
  function reconnect() {
    void documentSocket().connect();
    setAttempt((value) => value + 1);
  }
  return { ...state, reconnect };
}
