import { randomUUID } from "node:crypto";
import { Hocuspocus } from "@hocuspocus/server";
import { applyUpdate, encodeStateAsUpdate } from "yjs";
import { removeAwarenessStates } from "y-protocols/awareness";
import { getDatabase } from "@/lib/db";
import { log } from "@/lib/logging";
import { realtimeDocumentNameSchema, type RealtimeUser } from "@/lib/shared";
import { authorizeDocument } from "./auth";

export type DocumentContext = {
  userId: string;
  projectId: string;
  user: RealtimeUser;
  // Several providers can share one socket, so connections need their own id.
  connectionId: string;
};

function itemIdFromName(name: string): string {
  return realtimeDocumentNameSchema.parse(name).slice("item:".length);
}

// Each page or code file is one Yjs document named "item:<itemId>". Access is
// checked once per connection; after that the server only relays updates.
// Viewers get read-only connections, so Hocuspocus drops their edits.
export function createHocuspocus() {
  // Awareness client ids published by each connection, so a closed tab's
  // cursor disappears even if its state arrived as an update after a reconnect.
  const clientIds = new Map<string, Set<number>>();
  // Saved state read while authenticating, used by the load that follows.
  const prefetched = new Map<
    string,
    { state: Uint8Array | null; at: number }
  >();

  return new Hocuspocus<DocumentContext>({
    name: "collab",
    quiet: true,
    debounce: 2000,
    maxDebounce: 10_000,
    async onAuthenticate({
      documentName,
      requestHeaders,
      connectionConfig,
      instance,
    }) {
      const open =
        instance.documents.has(documentName) ||
        instance.loadingDocuments.has(documentName);
      const access = await authorizeDocument(
        requestHeaders,
        itemIdFromName(documentName),
        !open,
      );
      if (!open)
        prefetched.set(documentName, { state: access.state, at: Date.now() });
      connectionConfig.readOnly = access.role === "VIEWER";
      return {
        userId: access.user.id,
        projectId: access.projectId,
        user: access.user,
        connectionId: randomUUID(),
      };
    },
    async onLoadDocument({ documentName, document }) {
      const cached = prefetched.get(documentName);
      prefetched.delete(documentName);
      let state =
        cached && Date.now() - cached.at < 5000 ? cached.state : undefined;
      if (state === undefined) {
        const item = await getDatabase().item.findUnique({
          where: { id: itemIdFromName(documentName) },
          select: { type: true, yjsState: true },
        });
        if (!item || item.type === "FOLDER")
          throw new Error("This document is unavailable.");
        state = item.yjsState;
      }
      if (state) applyUpdate(document, state);
    },
    async onStoreDocument({ documentName, document }) {
      try {
        await getDatabase().item.updateMany({
          where: {
            id: itemIdFromName(documentName),
            type: { in: ["PAGE", "CODE"] },
          },
          data: { yjsState: new Uint8Array(encodeStateAsUpdate(document)) },
        });
      } catch (error) {
        log("error", "document.store_failed", {
          code: "DOCUMENT_STORE_FAILED",
        });
        throw error;
      }
    },
    async beforeHandleAwareness({ states, context }) {
      if (!context) return;
      let owned = clientIds.get(context.connectionId);
      if (!owned) clientIds.set(context.connectionId, (owned = new Set()));
      for (const [clientId, state] of states) {
        // The decoder's scratch awareness adds its own empty state.
        if (Object.keys(state).length === 0) {
          states.delete(clientId);
          continue;
        }
        // Names and colours come from the signed-in account, never the client.
        state.user = context.user;
        owned.add(clientId);
      }
    },
    async onDisconnect({ document, context }) {
      const owned = clientIds.get(context.connectionId);
      if (owned?.size)
        removeAwarenessStates(document.awareness, [...owned], null);
      clientIds.delete(context.connectionId);
    },
  });
}
