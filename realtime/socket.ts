import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { chatUserSelection, getDatabase, serializeChatMessage } from "@/lib/db";
import { consumeRateLimit, RateLimitError } from "@/lib/rate-limit";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@/lib/realtime-events";
import {
  chatSendSchema,
  chatTypingSchema,
  hasMinimumRole,
  presenceUpdateSchema,
  projectIdSchema,
  type ChatMessage,
  type ChatSendAck,
  type PresenceMember,
  type RealtimeUser,
  type Role,
} from "@/lib/shared";
import { log } from "@/lib/logging";
import { projectRole, sessionUser, toHeaders } from "./auth";

type SocketData = {
  user: RealtimeUser;
  projectId: string;
  role: Role;
  itemId: string | null;
  sharesPresence: boolean;
};

const room = (projectId: string) => `project:${projectId}`;

function isUniqueViolation(error: unknown) {
  return (error as { code?: unknown } | null)?.code === "P2002";
}

// One Socket.IO connection per open project carries chat, typing, presence,
// sidebar and run notifications. Access is checked when it connects.
export function createSocketServer(httpServer: HttpServer, origin: string) {
  const io = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >(httpServer, {
    maxHttpBufferSize: 16 * 1024,
    pingInterval: 10_000,
    pingTimeout: 5_000,
    // Other upgrade requests belong to Hocuspocus and Next.js.
    destroyUpgrade: false,
    allowRequest: (request, callback) =>
      callback(
        null,
        request.headers.origin === undefined ||
          request.headers.origin === origin,
      ),
  });

  io.use((socket, next) => {
    void (async () => {
      const auth = socket.handshake.auth as { projectId?: unknown };
      const projectId = projectIdSchema.parse(auth.projectId);
      const user = await sessionUser(toHeaders(socket.request.headers));
      const role = await projectRole(projectId, user.id);
      socket.data = {
        user,
        projectId,
        role,
        itemId: null,
        sharesPresence: false,
      };
      next();
    })().catch(() =>
      next(new Error("This project connection is not authorized.")),
    );
  });

  const typing = new Map<
    string,
    Map<string, { user: ChatMessage["user"]; until: number }>
  >();

  function publishTyping(projectId: string) {
    const entries = typing.get(projectId);
    const users = new Map<string, ChatMessage["user"]>();
    const now = Date.now();
    for (const [socketId, entry] of entries ?? []) {
      if (entry.until <= now) entries?.delete(socketId);
      else users.set(entry.user.id, entry.user);
    }
    if (entries?.size === 0) typing.delete(projectId);
    io.to(room(projectId)).emit("chat:typing", {
      projectId,
      users: [...users.values()].sort((a, b) => a.id.localeCompare(b.id)),
    });
  }

  function publishPresence(projectId: string) {
    const members = new Map<string, PresenceMember>();
    for (const socketId of io.sockets.adapter.rooms.get(room(projectId)) ??
      []) {
      const data = io.sockets.sockets.get(socketId)?.data;
      if (!data?.sharesPresence) continue;
      const member = members.get(data.user.id) ?? {
        user: data.user,
        itemIds: [],
        viewingOverview: false,
      };
      if (!data.itemId) member.viewingOverview = true;
      else if (!member.itemIds.includes(data.itemId))
        member.itemIds.push(data.itemId);
      members.set(data.user.id, member);
    }
    io.to(room(projectId)).emit("presence:changed", {
      projectId,
      users: [...members.values()]
        .map((member) => ({ ...member, itemIds: member.itemIds.sort() }))
        .sort(
          (left, right) =>
            left.user.name.localeCompare(right.user.name) ||
            left.user.id.localeCompare(right.user.id),
        ),
    });
  }

  async function sendChat(
    data: SocketData,
    input: unknown,
  ): Promise<ChatSendAck> {
    const parsed = chatSendSchema.safeParse(input);
    if (!parsed.success)
      return {
        ok: false,
        error: {
          code: "INVALID_INPUT",
          message:
            "Write a message of 1–2000 characters with a valid message ID.",
        },
      };
    const message = parsed.data;
    if (
      message.projectId !== data.projectId ||
      !hasMinimumRole(data.role, "EDITOR")
    )
      return {
        ok: false,
        error: {
          code: "FORBIDDEN",
          message:
            "You do not have permission to send messages in this project.",
        },
      };
    const userId = data.user.id;
    const database = getDatabase();
    let row;
    let created = true;
    try {
      consumeRateLimit("chat", userId, message.projectId);
      row = await database.chatMessage.create({
        data: {
          projectId: message.projectId,
          userId,
          clientMessageId: message.clientMessageId,
          body: message.body,
        },
        include: { user: { select: chatUserSelection } },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A retry of a message that was already saved: confirm it again.
      row = await database.chatMessage.findUnique({
        where: {
          userId_clientMessageId: {
            userId,
            clientMessageId: message.clientMessageId,
          },
        },
        include: { user: { select: chatUserSelection } },
      });
      if (
        !row ||
        row.projectId !== message.projectId ||
        row.body !== message.body
      )
        return {
          ok: false,
          error: {
            code: "INVALID_INPUT",
            message: "This message ID was already used.",
          },
        };
      created = false;
    }
    const saved = serializeChatMessage(row);
    if (created) io.to(room(message.projectId)).emit("chat:message", saved);
    return { ok: true, message: saved };
  }

  io.on("connection", (socket) => {
    const { projectId } = socket.data;
    void socket.join(room(projectId));
    let lastTyping = 0;
    let sending = 0;

    socket.on("presence:update", (input, acknowledge) => {
      const parsed = presenceUpdateSchema.safeParse(input);
      if (!parsed.success || parsed.data.projectId !== projectId) {
        acknowledge({
          ok: false,
          error: {
            code: "INVALID_INPUT",
            message: "Choose a page in this project.",
          },
        });
        return;
      }
      socket.data.itemId = parsed.data.itemId;
      socket.data.sharesPresence = true;
      publishPresence(projectId);
      acknowledge({ ok: true });
    });

    socket.on("chat:typing", (input) => {
      const parsed = chatTypingSchema.safeParse(input);
      if (
        !parsed.success ||
        parsed.data.projectId !== projectId ||
        !hasMinimumRole(socket.data.role, "EDITOR")
      )
        return;
      const entries = typing.get(projectId) ?? new Map();
      if (parsed.data.typing) {
        const now = Date.now();
        if (now - lastTyping < 500) return;
        lastTyping = now;
        const { id, name, color } = socket.data.user;
        entries.set(socket.id, {
          user: { id, name, color },
          until: now + 4000,
        });
        typing.set(projectId, entries);
      } else if (!entries.delete(socket.id)) return;
      publishTyping(projectId);
    });

    socket.on("chat:send", (input, acknowledge) => {
      const reply = (result: ChatSendAck) => {
        if (typeof acknowledge === "function") acknowledge(result);
      };
      if (sending >= 5) {
        reply({
          ok: false,
          error: {
            code: "BUSY",
            message: "Wait for your previous messages to finish sending.",
          },
        });
        return;
      }
      sending += 1;
      sendChat(socket.data, input)
        .then((result) => {
          reply(result);
          if (result.ok && typing.get(projectId)?.delete(socket.id))
            publishTyping(projectId);
        })
        .catch((error: unknown) => {
          if (error instanceof RateLimitError)
            reply({
              ok: false,
              error: { code: "RATE_LIMITED", message: error.message },
              retryAfter: Math.min(60, error.retryAfter),
            });
          else {
            log("error", "chat.failed", { code: "SEND_FAILED" });
            console.error(error);
            reply({
              ok: false,
              error: {
                code: "SEND_FAILED",
                message:
                  "Your message could not be confirmed. Retry with the same message.",
              },
            });
          }
        })
        .finally(() => {
          sending -= 1;
        });
    });

    socket.on("disconnect", () => {
      if (typing.get(projectId)?.delete(socket.id)) publishTyping(projectId);
      if (socket.data.sharesPresence) publishPresence(projectId);
    });
  });

  // Typing indicators expire after a few seconds without a new keystroke.
  const expireTyping = setInterval(() => {
    const now = Date.now();
    for (const [projectId, entries] of typing)
      if ([...entries.values()].some((entry) => entry.until <= now))
        publishTyping(projectId);
  }, 1000);
  expireTyping.unref();

  function emitToProject<Event extends keyof ServerToClientEvents>(
    projectId: string,
    event: Event,
    ...payload: Parameters<ServerToClientEvents[Event]>
  ) {
    io.to(room(projectId)).emit(event, ...payload);
  }

  return {
    emitToProject,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(expireTyping);
        io.close(() => resolve());
      }),
  };
}
