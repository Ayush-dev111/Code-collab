import {
  IncomingMessage as YjsIncomingMessage,
  MessageType,
  Server,
  type Connection,
} from "@hocuspocus/server";
import { getDatabase } from "@collab/db";
import { structuredLog } from "@collab/server";
import { captureServerError } from "@collab/server/monitoring";
import {
  awarenessStateSchema,
  emptyInputSchema,
  realtimeConnectionContextSchema,
  realtimeDocumentNameSchema,
  realtimeEnvironmentSchema,
  realtimeUserSchema,
  userColor,
  yjsMessageSchema,
  yjsSyncTypeSchema,
  type RealtimeConnectionContext,
} from "@collab/shared";
import { applyUpdate, Doc, encodeStateAsUpdate } from "yjs";
import { removeAwarenessStates } from "y-protocols/awareness";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  requireRealtimeAuthorization,
  type RealtimeAuthorization,
} from "./authorization.ts";

function itemIdFromName(input: unknown): string {
  return realtimeDocumentNameSchema.parse(input).slice("item:".length);
}

function connectionContext(
  token: string,
  authorization: RealtimeAuthorization,
): RealtimeConnectionContext {
  const candidate = {
    id: authorization.user.id,
    name: authorization.user.name.trim().slice(0, 80) || "Collaborator",
    image: authorization.user.image,
    color: userColor(authorization.user.id),
  };
  const user = realtimeUserSchema.safeParse(candidate);
  return realtimeConnectionContextSchema.parse({
    token,
    claims: authorization.claims,
    user: user.success ? user.data : { ...candidate, image: null },
  });
}

export function createHocuspocusServer(
  handleRequest: (
    request: IncomingMessage,
    response: ServerResponse,
  ) => Promise<void>,
): Server<RealtimeConnectionContext> {
  const environment = realtimeEnvironmentSchema.parse(process.env);
  const applicationOrigin = new URL(environment.BETTER_AUTH_URL).origin;
  const awarenessOwners = new Map<string, Map<number, string>>();
  const connectionClients = new Map<string, number>();
  const messageReleases = new WeakMap<
    Connection<RealtimeConnectionContext>,
    () => void
  >();

  async function refreshConnection(
    connection: Connection<RealtimeConnectionContext>,
    documentName: string,
  ): Promise<RealtimeAuthorization> {
    const context = realtimeConnectionContextSchema.parse(connection.context);
    const authorization = await requireRealtimeAuthorization(
      context.token,
      context.claims.projectId,
      itemIdFromName(documentName),
    );
    connection.readOnly = authorization.role === "VIEWER";
    connection.context = connectionContext(context.token, authorization);
    return authorization;
  }

  return new Server<RealtimeConnectionContext>({
    name: "Collab",
    port: environment.REALTIME_PORT,
    address: environment.REALTIME_HOST,
    quiet: true,
    stopOnSignals: false,
    debounce: 1_000,
    maxDebounce: 5_000,
    unloadImmediately: true,
    timeout: 15_000,
    maxUnauthenticatedQueueSize: environment.REALTIME_MAX_MESSAGE_BYTES,
    maxUnauthenticatedQueueMessages: 32,
    maxPendingDocuments: 8,
    websocketOptions: { maxPayload: environment.REALTIME_MAX_MESSAGE_BYTES },
    async onUpgrade({ request, socket }) {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname.startsWith("/socket.io/")) {
        return Promise.reject();
      }
      const origin = request.headers.origin;
      if (
        url.pathname !== "/yjs" ||
        (origin !== undefined && origin !== applicationOrigin)
      ) {
        socket.destroy();
        return Promise.reject();
      }
      try {
        emptyInputSchema.parse(Object.fromEntries(url.searchParams));
      } catch {
        socket.destroy();
        return Promise.reject();
      }
    },
    async onRequest({ request, response }) {
      await handleRequest(request, response);
      // Hocuspocus documents this empty rejection as its handled-request signal.
      return Promise.reject();
    },
    async onAuthenticate({
      token,
      documentName,
      connectionConfig,
      requestHeaders,
    }) {
      const origin = requestHeaders.get("origin");
      if (origin && origin !== applicationOrigin)
        throw new Error("Invalid origin.");
      const authorization = await requireRealtimeAuthorization(
        token,
        undefined,
        itemIdFromName(documentName),
      );
      connectionConfig.readOnly = authorization.role === "VIEWER";
      return connectionContext(token, authorization);
    },
    async onTokenSync({
      token,
      documentName,
      context,
      connection,
      connectionConfig,
    }) {
      const current = realtimeConnectionContextSchema.parse(context);
      const authorization = await requireRealtimeAuthorization(
        token,
        current.claims.projectId,
        itemIdFromName(documentName),
      );
      if (authorization.claims.userId !== current.claims.userId)
        throw new Error("The connection identity cannot change.");
      const replacement = connectionContext(token, authorization);
      Object.assign(context, replacement);
      connection.context = replacement;
      connection.readOnly = authorization.role === "VIEWER";
      connectionConfig.readOnly = connection.readOnly;
      return replacement;
    },
    async onLoadDocument({ documentName, context, document }) {
      const current = realtimeConnectionContextSchema.parse(context);
      const itemId = itemIdFromName(documentName);
      await requireRealtimeAuthorization(
        current.token,
        current.claims.projectId,
        itemId,
      );
      const item = await getDatabase().item.findFirst({
        where: {
          id: itemId,
          projectId: current.claims.projectId,
          type: { in: ["PAGE", "CODE"] },
        },
        select: { yjsState: true },
      });
      if (!item) throw new Error("This document is unavailable.");
      if (item.yjsState) {
        if (item.yjsState.byteLength > environment.REALTIME_MAX_DOCUMENT_BYTES)
          throw new Error("This document exceeds the size limit.");
        applyUpdate(document, item.yjsState);
      }
    },
    async beforeHandleMessage({ connection, documentName, document, update }) {
      if (update.byteLength > environment.REALTIME_MAX_MESSAGE_BYTES)
        throw new Error("This message exceeds the size limit.");
      const message = new YjsIncomingMessage(yjsMessageSchema.parse(update));
      const address = message.readVarString().split("\0")[0];
      if (realtimeDocumentNameSchema.parse(address) !== documentName)
        throw new Error("Invalid document address.");
      const messageType = message.readVarUint();
      if (
        ![
          MessageType.Sync,
          MessageType.SyncReply,
          MessageType.Awareness,
          MessageType.Auth,
          MessageType.QueryAwareness,
          MessageType.CLOSE,
        ].includes(messageType)
      )
        throw new Error("This message type is not supported.");
      // The library serializes each connection's messages. This document mutex
      // also serializes across writers, keeping size checks atomic with applying
      // an update and keeping persistence from racing a partially checked write.
      const release = await document.saveMutex.acquire();
      try {
        await refreshConnection(connection, documentName);
        messageReleases.set(connection, release);
      } catch (error) {
        release();
        throw error;
      }
    },
    async afterHandleMessage({ connection, document, instance }) {
      messageReleases.get(connection)?.();
      messageReleases.delete(connection);
      if (document.getConnectionsCount() === 0)
        await instance.unloadDocument(document);
    },
    async beforeSync({ connection, documentName, document, type, payload }) {
      yjsSyncTypeSchema.parse(type);
      yjsMessageSchema.parse(payload);
      if (payload.byteLength > environment.REALTIME_MAX_MESSAGE_BYTES)
        throw new Error("This update exceeds the size limit.");
      if (type === 0 || connection.readOnly) return;
      const candidate = new Doc();
      try {
        applyUpdate(candidate, encodeStateAsUpdate(document));
        applyUpdate(candidate, payload);
        if (
          encodeStateAsUpdate(candidate).byteLength >
          environment.REALTIME_MAX_DOCUMENT_BYTES
        )
          throw new Error("This document exceeds the size limit.");
      } finally {
        candidate.destroy();
      }
      await refreshConnection(connection, documentName);
    },
    async beforeHandleAwareness({ documentName, states, connection }) {
      if (!connection) throw new Error("Missing awareness connection.");
      const authorization = await refreshConnection(connection, documentName);
      const user = connectionContext(
        connection.context.token,
        authorization,
      ).user;
      if (states.size > 64) throw new Error("Too many awareness states.");
      let owners = awarenessOwners.get(documentName);
      if (!owners) {
        owners = new Map();
        awarenessOwners.set(documentName, owners);
      }
      for (const [clientId, value] of states) {
        // The Hocuspocus scratch Awareness includes its own empty local state.
        if (Object.keys(value).length === 0) {
          states.delete(clientId);
          continue;
        }
        const owner = owners.get(clientId);
        const ownershipKey = `${documentName}\0${connection.socketId}`;
        const assignedClient = connectionClients.get(ownershipKey);
        if (
          !Number.isSafeInteger(clientId) ||
          clientId < 0 ||
          clientId > 0xffffffff ||
          (owner !== undefined && owner !== connection.socketId) ||
          (assignedClient !== undefined && assignedClient !== clientId)
        )
          throw new Error("The awareness identity is not authorized.");
        const stamped = awarenessStateSchema.parse({ ...value, user });
        if (Buffer.byteLength(JSON.stringify(stamped), "utf8") > 16 * 1024)
          throw new Error("This awareness state is too large.");
        owners.set(clientId, connection.socketId);
        connectionClients.set(ownershipKey, clientId);
        states.set(clientId, stamped);
      }
    },
    async onStoreDocument({ documentName, document }) {
      const itemId = itemIdFromName(documentName);
      const state = encodeStateAsUpdate(document);
      if (state.byteLength > environment.REALTIME_MAX_DOCUMENT_BYTES)
        throw new Error("This document exceeds the size limit.");
      try {
        await getDatabase().item.updateMany({
          where: { id: itemId, type: { in: ["PAGE", "CODE"] } },
          data: { yjsState: new Uint8Array(state) },
        });
      } catch (error) {
        structuredLog("realtime", "error", "document.store_failed", {
          code: "DOCUMENT_STORE_FAILED",
        });
        captureServerError(error);
        throw new Error(
          "The document could not be saved. Keep the tab open and retry.",
        );
      }
    },
    async onDisconnect({ documentName, document, socketId }) {
      const ownershipKey = `${documentName}\0${socketId}`;
      const clientId = connectionClients.get(ownershipKey);
      const owners = awarenessOwners.get(documentName);
      if (clientId !== undefined && owners?.get(clientId) === socketId) {
        // Track ownership independently of Hocuspocus's added-state bookkeeping:
        // a reconnected client's existing state can arrive as an update instead.
        removeAwarenessStates(document.awareness, [clientId], null);
        owners.delete(clientId);
      }
      connectionClients.delete(ownershipKey);
    },
    async afterUnloadDocument({ documentName }) {
      awarenessOwners.delete(documentName);
    },
  });
}
