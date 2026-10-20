"use client";

import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { realtimeDocumentNameSchema } from "@collab/shared";
import { ApiClientError, errorMessage } from "@/lib/api-client";
import {
  documentWebSocketUrl,
  requestRealtimeToken,
} from "@/lib/realtime-client";

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

export function useDocumentSession(projectId: string, itemId: string) {
  const [state, setState] = useState<DocumentState>(initialState);
  const [attempt, setAttempt] = useState(0);
  const providerRef = useRef<HocuspocusProvider | null>(null);
  useEffect(() => {
    let active = true;
    const document = new Y.Doc();
    let provider: HocuspocusProvider | undefined;
    let wasWritable = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    function patch(update: Partial<DocumentState>) {
      if (active) setState((current) => ({ ...current, ...update }));
    }
    async function token() {
      try {
        const result = await requestRealtimeToken(projectId);
        if (active) {
          clearTimeout(refreshTimer);
          refreshTimer = setTimeout(
            () => {
              if (provider?.isAuthenticated) void provider.sendToken();
            },
            Math.max(1000, Date.parse(result.expiresAt) - Date.now() - 30000),
          );
        }
        return result;
      } catch (error) {
        patch({
          error: errorMessage(error),
          ...(error instanceof ApiClientError &&
          [401, 403, 404].includes(error.status)
            ? { writable: false }
            : {}),
        });
        throw error;
      }
    }
    async function start() {
      try {
        const initial = await token();
        if (!active) return;
        provider = new HocuspocusProvider({
          url: documentWebSocketUrl(initial.url),
          name: realtimeDocumentNameSchema.parse(`item:${itemId}`),
          document,
          token: async () => (await token()).token,
          onStatus: ({ status }) =>
            patch({ connected: status === "connected" }),
          onSynced: ({ state: synced }) => {
            if (synced) patch({ synced: true });
          },
          onAuthenticated: ({ scope }) => {
            wasWritable ||= scope === "read-write";
            patch({
              writable: scope === "read-write",
              wasWritable,
              error: null,
            });
          },
          onAuthenticationFailed: ({ reason }) =>
            patch({
              writable: false,
              error:
                reason ||
                "Your editing access could not be verified. Reconnect to try again.",
            }),
          onUnsyncedChanges: ({ number }) => patch({ unsyncedChanges: number }),
          onClose: ({ event }) => {
            if (
              event.code === 1008 ||
              event.code === 4401 ||
              event.code === 4403
            )
              patch({
                writable: false,
                error:
                  event.reason ||
                  "Your access to this document changed. Reconnect to verify access.",
              });
          },
        });
        providerRef.current = provider;
        patch({ provider });
      } catch (error) {
        patch({ error: errorMessage(error) });
      }
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (wasWritable && provider?.hasUnsyncedChanges) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const beforeNavigate = (event: MouseEvent) => {
      if (
        !wasWritable ||
        !provider?.hasUnsyncedChanges ||
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
      if (
        !window.confirm(
          "This document has changes waiting to sync. Leave and discard those pending changes?",
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const beforeProgrammaticNavigate = (event: Event) => {
      if (
        wasWritable &&
        provider?.hasUnsyncedChanges &&
        !window.confirm(
          "This document has changes waiting to sync. Leave and discard those pending changes?",
        )
      )
        event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    window.addEventListener("click", beforeNavigate, true);
    window.addEventListener(
      "collab:before-navigation",
      beforeProgrammaticNavigate,
    );
    void start();
    return () => {
      active = false;
      clearTimeout(refreshTimer);
      window.removeEventListener("beforeunload", beforeUnload);
      window.removeEventListener("click", beforeNavigate, true);
      window.removeEventListener(
        "collab:before-navigation",
        beforeProgrammaticNavigate,
      );
      providerRef.current = null;
      provider?.destroy();
      document.destroy();
    };
  }, [attempt, itemId, projectId]);
  function reconnect() {
    const provider = providerRef.current;
    if (!provider) {
      setAttempt((value) => value + 1);
      return;
    }
    provider.configuration.websocketProvider.disconnect();
    void provider.configuration.websocketProvider.connect();
  }
  return { ...state, reconnect };
}
