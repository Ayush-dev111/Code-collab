import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server as SocketIOServer } from "socket.io";
import {
  realtimeSocketAuthSchema,
  treeChangedNotificationSchema,
  treeChangedSchema,
  treeNotificationResponseSchema,
  treeSubscribeAckSchema,
  treeSubscribeSchema,
  type PresenceUpdateAck,
  type ProjectPresence,
  type RealtimeUser,
  type RunEvent,
  type ChatMessage,
  type ChatSendAck,
  type ChatTypingEvent,
} from "@collab/shared";
import {
  requireRealtimeActor,
  requireRealtimeAuthorization,
  type RealtimeActor,
} from "./authorization.ts";

type SubscribeAck = ReturnType<typeof treeSubscribeAckSchema.parse>;
type TreeChanged = ReturnType<typeof treeChangedSchema.parse>;

export interface ClientToServerEvents {
  "chat:send": (
    input: unknown,
    acknowledge?: (result: ChatSendAck) => void,
  ) => void;
  "chat:typing": (
    input: unknown,
    acknowledge?: (result: PresenceUpdateAck) => void,
  ) => void;
  "presence:update": (
    input: unknown,
    acknowledge?: (result: PresenceUpdateAck) => void,
  ) => void;
  "tree:subscribe": (
    input: unknown,
    acknowledge?: (result: SubscribeAck) => void,
  ) => void;
}
export interface ServerToClientEvents {
  "chat:message": (message: ChatMessage) => void;
  "chat:typing": (event: ChatTypingEvent) => void;
  "run:started": (event: RunEvent) => void;
  "run:finished": (event: RunEvent) => void;
  "presence:changed": (event: ProjectPresence) => void;
  "tree:changed": (event: TreeChanged) => void;
}
export type InterServerEvents = Record<string, never>;
export interface SocketData {
  token: string;
  projectId: string;
  presence?: { user: RealtimeUser; itemId: string | null };
}
export type TreeServer = SocketIOServer<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

const roomName = (projectId: string): string => `project:${projectId}`;

export function configureTreeEvents(io: TreeServer): void {
  io.use((socket, next) => {
    void (async () => {
      const { token } = realtimeSocketAuthSchema.parse(socket.handshake.auth);
      const authorization = await requireRealtimeAuthorization(token);
      socket.data = { token, projectId: authorization.claims.projectId };
      next();
    })().catch(() => next(new Error("The connection is not authorized.")));
  });
  io.on("connection", (socket) => {
    socket.on("error", () => socket.disconnect(true));
    // Socket.IO rooms are server-controlled. Clients only request a validated
    // subscription and cannot publish a tree notification or change their scope.
    socket.use(([event], next) => {
      if (
        ![
          "tree:subscribe",
          "presence:update",
          "chat:send",
          "chat:typing",
        ].includes(event)
      ) {
        next(new Error("This event is not supported."));
        return;
      }
      void requireRealtimeAuthorization(socket.data.token).then(
        () => next(),
        () => {
          socket.disconnect(true);
          next(new Error("The connection is no longer authorized."));
        },
      );
    });
    socket.on("tree:subscribe", (input, acknowledge) => {
      void (async () => {
        const { projectId } = treeSubscribeSchema.parse(input);
        await requireRealtimeAuthorization(socket.data.token, projectId);
        await socket.join(roomName(projectId));
        if (typeof acknowledge === "function")
          acknowledge(treeSubscribeAckSchema.parse({ ok: true }));
      })().catch(() => {
        if (typeof acknowledge === "function")
          acknowledge(
            treeSubscribeAckSchema.parse({
              ok: false,
              error: {
                code: "FORBIDDEN",
                message: "This project subscription is not authorized.",
              },
            }),
          );
      });
    });
  });
}

async function publishTreeChanged(
  io: TreeServer,
  actor: RealtimeActor,
): Promise<void> {
  await requireRealtimeActor(actor, "EDITOR");
  const event = treeChangedSchema.parse({
    projectId: actor.projectId,
    changedAt: new Date().toISOString(),
  });
  const recipients = await io.in(roomName(actor.projectId)).fetchSockets();
  await Promise.all(
    recipients.map(async (socket) => {
      try {
        await requireRealtimeAuthorization(socket.data.token, actor.projectId);
        socket.emit("tree:changed", event);
      } catch {
        socket.disconnect(true);
      }
    }),
  );
}

function authorizedInternalRequest(
  request: IncomingMessage,
  secret: string,
): boolean {
  const value = request.headers.authorization;
  if (typeof value !== "string" || value.length > 4096) return false;
  const provided = Buffer.from(value, "utf8");
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  return (
    provided.length === expected.length && timingSafeEqual(provided, expected)
  );
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

export async function handleTreeNotification(
  request: IncomingMessage,
  response: ServerResponse,
  io: TreeServer,
  secret: string,
): Promise<void> {
  if (!authorizedInternalRequest(request, secret)) {
    request.resume();
    sendJson(response, 401, {
      code: "UNAUTHENTICATED",
      message: "Not authorized.",
    });
    return;
  }
  if (
    request.headers["content-type"]?.split(";")[0]?.trim() !==
    "application/json"
  ) {
    request.resume();
    sendJson(response, 415, {
      code: "INVALID_INPUT",
      message: "Send a JSON body.",
    });
    return;
  }
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const input of request) {
      const chunk =
        input instanceof Buffer ? input : Buffer.from(input as Uint8Array);
      length += chunk.byteLength;
      if (length > 16 * 1024) {
        sendJson(response, 413, {
          code: "BODY_TOO_LARGE",
          message: "The request is too large.",
        });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    }
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
    const json: unknown = JSON.parse(decoded);
    const actor = treeChangedNotificationSchema.parse(json);
    await publishTreeChanged(io, actor);
    sendJson(
      response,
      200,
      treeNotificationResponseSchema.parse({ published: true }),
    );
  } catch {
    sendJson(response, 403, {
      code: "INVALID_NOTIFICATION",
      message: "The tree notification was rejected.",
    });
  }
}
