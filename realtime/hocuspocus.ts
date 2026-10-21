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

  return new Hocuspocus<DocumentContext>({
    name: "collab",
    quiet: true,
    debounce: 2000,
    maxDebounce: 10_000,
    async onAuthenticate({ documentName, requestHeaders, connectionConfig }) {
      const access = await authorizeDocument(
        requestHeaders,
        itemIdFromName(documentName),
      );
      connectionConfig.readOnly = access.role === "VIEWER";
      return {
        userId: access.user.id,
        projectId: access.projectId,
        user: access.user,
      };
    },
    async onLoadDocument({ documentName, document }) {
      const item = await getDatabase().item.findUnique({
        where: { id: itemIdFromName(documentName) },
        select: { type: true, yjsState: true },
      });
      if (!item || item.type === "FOLDER")
        throw new Error("This document is unavailable.");
      if (item.yjsState) applyUpdate(document, item.yjsState);
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
    async beforeHandleAwareness({ documentName, states, context, socketId }) {
      if (!context) return;
      const key = `${documentName}\0${socketId}`;
      let owned = clientIds.get(key);
      if (!owned) clientIds.set(key, (owned = new Set()));
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
    async onDisconnect({ documentName, document, socketId }) {
      const key = `${documentName}\0${socketId}`;
      const owned = clientIds.get(key);
      if (owned?.size)
        removeAwarenessStates(document.awareness, [...owned], null);
      clientIds.delete(key);
    },
  });
}
