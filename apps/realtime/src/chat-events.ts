import {
  chatUserSelection,
  getDatabase,
  serializeChatMessage,
} from "@collab/db";
import {
  consumeRateLimit,
  RateLimitError,
  structuredLog,
} from "@collab/server";
import { captureServerError } from "@collab/server/monitoring";
import {
  chatSendSchema,
  chatSendAckSchema,
  chatTypingSchema,
  chatTypingEventSchema,
  hasMinimumRole,
  userColor,
  type ChatMessage,
} from "@collab/shared";
import {
  requireRealtimeAuthorization,
  RealtimeAuthorizationError,
} from "./authorization.ts";
import type { TreeServer } from "./tree-events.ts";

export function configureChatEvents(io: TreeServer): () => void {
  const typing = new Map<
    string,
    { projectId: string; user: ChatMessage["user"]; until: number }
  >();
  const queues = new Map<string, Promise<void>>();
  const typingQueues = new Map<string, Promise<void>>();
  let stopped = false;

  async function recipients(projectId: string) {
    const sockets = [...io.of("/").sockets.values()].filter((socket) =>
      socket.rooms.has(`project:${projectId}`),
    );
    return (
      await Promise.all(
        sockets.map(async (socket) => {
          try {
            await requireRealtimeAuthorization(socket.data.token, projectId);
            return socket;
          } catch {
            socket.disconnect(true);
            return null;
          }
        }),
      )
    ).filter(
      (socket): socket is NonNullable<typeof socket> =>
        socket !== null && socket.connected,
    );
  }
  function publishTyping(projectId: string) {
    const previous = typingQueues.get(projectId) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        if (stopped) return;
        const sockets = await recipients(projectId);
        const users = new Map<string, ChatMessage["user"]>();
        for (const [socketId, entry] of typing) {
          if (entry.projectId !== projectId) continue;
          const socket = io.of("/").sockets.get(socketId);
          if (!socket?.connected || entry.until <= Date.now()) {
            typing.delete(socketId);
            continue;
          }
          try {
            const auth = await requireRealtimeAuthorization(
              socket.data.token,
              projectId,
            );
            if (!hasMinimumRole(auth.role, "EDITOR")) {
              typing.delete(socketId);
              continue;
            }
            users.set(entry.user.id, entry.user);
          } catch {
            typing.delete(socketId);
            socket.disconnect(true);
          }
        }
        const event = chatTypingEventSchema.parse({
          projectId,
          users: [...users.values()].sort((a, b) => a.id.localeCompare(b.id)),
        });
        for (const socket of sockets)
          if (socket.connected) socket.emit("chat:typing", event);
      })
      .catch(() => {
        /* The next snapshot can recover after a database outage. */
      });
    typingQueues.set(projectId, next);
    void next.finally(() => {
      if (typingQueues.get(projectId) === next) typingQueues.delete(projectId);
    });
  }
  async function saveMessage(token: string, input: unknown) {
    const parsed = chatSendSchema.safeParse(input);
    if (!parsed.success)
      return chatSendAckSchema.parse({
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message:
            "Write a message of 1–2000 characters with a valid message ID.",
        },
      });
    const data = parsed.data;
    const auth = await requireRealtimeAuthorization(token, data.projectId);
    if (!hasMinimumRole(auth.role, "EDITOR"))
      throw new RealtimeAuthorizationError();
    const result = await getDatabase().$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT id FROM project WHERE id = ${data.projectId} FOR UPDATE`;
      const [membership, session] = await Promise.all([
        transaction.projectMember.findUnique({
          where: {
            projectId_userId: {
              projectId: data.projectId,
              userId: auth.user.id,
            },
          },
        }),
        transaction.session.findUnique({
          where: { id: auth.claims.sessionId },
        }),
      ]);
      if (
        !membership ||
        !hasMinimumRole(membership.role, "EDITOR") ||
        !session ||
        session.userId !== auth.user.id ||
        session.expiresAt.getTime() <= Date.now() ||
        auth.claims.exp * 1000 <= Date.now()
      )
        throw new RealtimeAuthorizationError();
      const existing = await transaction.chatMessage.findUnique({
        where: {
          userId_clientMessageId: {
            userId: auth.user.id,
            clientMessageId: data.clientMessageId,
          },
        },
        include: { user: { select: chatUserSelection } },
      });
      if (existing) {
        if (
          existing.projectId !== data.projectId ||
          existing.body !== data.body
        )
          throw new Error("Message ID was reused.");
        return { row: existing, created: false };
      }
      await consumeRateLimit("chat", auth.user.id, data.projectId);
      const row = await transaction.chatMessage.create({
        data: {
          projectId: data.projectId,
          userId: auth.user.id,
          clientMessageId: data.clientMessageId,
          body: data.body,
          createdAt: new Date(),
        },
        include: { user: { select: chatUserSelection } },
      });
      return { row, created: true };
    });
    const message = serializeChatMessage(result.row);
    if (result.created) {
      for (const socket of await recipients(data.projectId))
        socket.emit("chat:message", message);
    }
    await requireRealtimeAuthorization(token, data.projectId);
    return chatSendAckSchema.parse({ ok: true, message });
  }

  io.on("connection", (socket) => {
    let pending = 0;
    let lastTyping = 0;
    socket.on("chat:send", (input, acknowledge) => {
      const reply = (value: unknown) => {
        if (typeof acknowledge === "function")
          acknowledge(chatSendAckSchema.parse(value));
      };
      if (pending >= 5) {
        reply({
          ok: false,
          error: {
            code: "BUSY",
            message: "Wait for your previous messages to finish sending.",
          },
        });
        return;
      }
      pending += 1;
      const projectId = socket.data.projectId;
      const previous = queues.get(projectId) ?? Promise.resolve();
      const next = previous
        .catch(() => {})
        .then(async () => {
          try {
            if (!socket.connected || stopped) return;
            reply(await saveMessage(socket.data.token, input));
            if (typing.delete(socket.id)) publishTyping(projectId);
          } catch (error) {
            if (
              !(error instanceof RealtimeAuthorizationError) &&
              !(error instanceof RateLimitError)
            ) {
              structuredLog("realtime", "error", "chat.failed", {
                code: "SEND_FAILED",
              });
              captureServerError(error);
            }
            reply({
              ok: false,
              error: {
                code:
                  error instanceof RateLimitError
                    ? error.code
                    : error instanceof RealtimeAuthorizationError
                      ? "FORBIDDEN"
                      : "SEND_FAILED",
                message:
                  error instanceof RateLimitError
                    ? error.message
                    : error instanceof RealtimeAuthorizationError
                      ? "You do not have permission to send messages in this project."
                      : "Your message could not be confirmed. Retry with the same message.",
              },
              ...(error instanceof RateLimitError &&
              error.retryAfter !== undefined
                ? { retryAfter: error.retryAfter }
                : {}),
            });
          } finally {
            pending -= 1;
          }
        });
      queues.set(projectId, next);
      void next.finally(() => {
        if (queues.get(projectId) === next) queues.delete(projectId);
      });
    });
    socket.on("chat:typing", (input, acknowledge) => {
      void (async () => {
        const { projectId, typing: active } = chatTypingSchema.parse(input);
        const auth = await requireRealtimeAuthorization(
          socket.data.token,
          projectId,
        );
        if (!hasMinimumRole(auth.role, "EDITOR"))
          throw new RealtimeAuthorizationError();
        if (active && Date.now() - lastTyping < 500) {
          if (typeof acknowledge === "function") acknowledge({ ok: true });
          return;
        }
        lastTyping = Date.now();
        if (active && socket.connected)
          typing.set(socket.id, {
            projectId,
            user: {
              id: auth.user.id,
              name: auth.user.name.trim().slice(0, 80) || "Collaborator",
              color: userColor(auth.user.id),
            },
            until: Date.now() + 4000,
          });
        else typing.delete(socket.id);
        publishTyping(projectId);
        if (typeof acknowledge === "function") acknowledge({ ok: true });
      })().catch(() => {
        if (typeof acknowledge === "function")
          acknowledge({
            ok: false,
            error: {
              code: "FORBIDDEN",
              message: "This typing update is not authorized.",
            },
          });
      });
    });
    socket.on("disconnect", () => {
      if (typing.delete(socket.id)) publishTyping(socket.data.projectId);
    });
  });
  const timer = setInterval(() => {
    const projects = new Set(
      [...typing.values()].map((entry) => entry.projectId),
    );
    for (const projectId of projects) publishTyping(projectId);
  }, 1000);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
    typing.clear();
  };
}
