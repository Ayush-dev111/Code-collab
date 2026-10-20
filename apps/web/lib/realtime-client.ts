"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { io, type Socket } from "socket.io-client";
import {
  realtimeTokenRequestSchema,
  realtimeTokenResponseSchema,
  treeChangedSchema,
  treeSubscribeAckSchema,
  treeSubscribeSchema,
  presenceUpdateSchema,
  presenceUpdateAckSchema,
  projectPresenceSchema,
  type PresenceMember,
  runEventSchema,
  chatMessageSchema,
  chatSendAckSchema,
  chatSendSchema,
  chatTypingSchema,
  chatTypingEventSchema,
  type ChatMessage,
  type ChatSend,
} from "@collab/shared";
import { apiRequest, errorMessage } from "@/lib/api-client";

export async function requestRealtimeToken(projectId: string) {
  return apiRequest("/api/realtime-token", realtimeTokenResponseSchema, {
    method: "POST",
    body: realtimeTokenRequestSchema.parse({ projectId }),
  });
}

export function documentWebSocketUrl(realtimeUrl: string) {
  const url = new URL("/yjs", realtimeUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function canLeaveSharedPage() {
  return window.dispatchEvent(
    new Event("collab:before-navigation", { cancelable: true }),
  );
}

export function useProjectRealtime(projectId: string, itemId: string | null) {
  const client = useQueryClient();
  const socketRef = useRef<Socket | undefined>(undefined);
  const locationRef = useRef(itemId);
  const chatListeners = useRef(new Set<(message: ChatMessage) => void>());
  const [typingUsers, setTypingUsers] = useState<ChatMessage["user"][]>([]);
  const [retry, setRetry] = useState(0);
  const [users, setUsers] = useState<PresenceMember[]>([]);
  const [connection, setConnection] = useState<{
    connected: boolean;
    error: string | null;
  }>({ connected: false, error: null });
  useEffect(() => {
    locationRef.current = itemId;
    const socket = socketRef.current;
    if (!socket?.connected) return;
    socket
      .timeout(10000)
      .emit(
        "presence:update",
        presenceUpdateSchema.parse({ projectId, itemId }),
        (error: unknown, response: unknown) => {
          const parsed = presenceUpdateAckSchema.safeParse(response);
          if (error || !parsed.success || !parsed.data.ok)
            setConnection({
              connected: false,
              error:
                "Your page location could not be shared. Retry to reconnect.",
            });
        },
      );
  }, [itemId, projectId]);
  useEffect(() => {
    let active = true;
    let socket: Socket | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const invalidate = () =>
      void client.invalidateQueries({ queryKey: ["items", projectId] });
    const refreshChat = () =>
      void client.invalidateQueries({ queryKey: ["chat", projectId] });
    async function freshToken() {
      const result = await requestRealtimeToken(projectId);
      if (!active) return result;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(
        () => {
          socket?.disconnect().connect();
        },
        Math.max(1000, Date.parse(result.expiresAt) - Date.now() - 30000),
      );
      return result;
    }
    async function connect() {
      try {
        const initial = await freshToken();
        if (!active) return;
        socket = io(initial.url, {
          autoConnect: false,
          auth: (callback) => {
            void freshToken()
              .then((token) => {
                if (active) callback({ token: token.token });
              })
              .catch((error: unknown) => {
                if (active)
                  setConnection({
                    connected: false,
                    error: errorMessage(error),
                  });
              });
          },
        });
        socketRef.current = socket;
        socket.on("connect", () => {
          const payload = treeSubscribeSchema.parse({ projectId });
          socket
            ?.timeout(10000)
            .emit(
              "tree:subscribe",
              payload,
              (error: unknown, response: unknown) => {
                if (!active) return;
                const parsed = treeSubscribeAckSchema.safeParse(response);
                if (error || !parsed.success) {
                  setConnection({
                    connected: false,
                    error:
                      "Live sidebar updates are unavailable. Retry to reconnect.",
                  });
                } else if (!parsed.data.ok) {
                  setConnection({
                    connected: false,
                    error: parsed.data.error.message,
                  });
                } else {
                  invalidate();
                  refreshChat();
                  socket?.timeout(10000).emit(
                    "presence:update",
                    presenceUpdateSchema.parse({
                      projectId,
                      itemId: locationRef.current,
                    }),
                    (presenceError: unknown, result: unknown) => {
                      if (!active) return;
                      const presence =
                        presenceUpdateAckSchema.safeParse(result);
                      if (
                        presenceError ||
                        !presence.success ||
                        !presence.data.ok
                      )
                        setConnection({
                          connected: false,
                          error:
                            "Live presence is unavailable. Retry to reconnect.",
                        });
                      else setConnection({ connected: true, error: null });
                    },
                  );
                }
              },
            );
        });
        socket.on("tree:changed", (payload: unknown) => {
          const parsed = treeChangedSchema.safeParse(payload);
          if (parsed.success && parsed.data.projectId === projectId)
            invalidate();
        });
        const invalidateRuns = (payload: unknown) => {
          const parsed = runEventSchema.safeParse(payload);
          if (active && parsed.success && parsed.data.projectId === projectId)
            void client.invalidateQueries({
              queryKey: ["runs", projectId, parsed.data.itemId],
            });
        };
        socket.on("run:started", invalidateRuns);
        socket.on("run:finished", invalidateRuns);
        socket.on("chat:message", (payload: unknown) => {
          const parsed = chatMessageSchema.safeParse(payload);
          if (!active || !parsed.success || parsed.data.projectId !== projectId)
            return;
          for (const listener of chatListeners.current) listener(parsed.data);
          refreshChat();
        });
        socket.on("chat:typing", (payload: unknown) => {
          const parsed = chatTypingEventSchema.safeParse(payload);
          if (active && parsed.success && parsed.data.projectId === projectId)
            setTypingUsers(parsed.data.users);
        });
        socket.on("presence:changed", (payload: unknown) => {
          const parsed = projectPresenceSchema.safeParse(payload);
          if (active && parsed.success && parsed.data.projectId === projectId)
            setUsers(parsed.data.users);
        });
        socket.on("disconnect", () => {
          if (active) {
            setUsers([]);
            setTypingUsers([]);
            setConnection({ connected: false, error: null });
          }
        });
        socket.on("connect_error", (error: Error) => {
          if (active)
            setConnection({ connected: false, error: errorMessage(error) });
        });
        socket.connect();
      } catch (error) {
        if (active)
          setConnection({ connected: false, error: errorMessage(error) });
      }
    }
    void connect();
    return () => {
      active = false;
      clearTimeout(refreshTimer);
      socket?.removeAllListeners();
      socket?.disconnect();
      if (socketRef.current === socket) socketRef.current = undefined;
    };
  }, [client, projectId, retry]);
  const subscribeChat = useCallback(
    (listener: (message: ChatMessage) => void) => {
      chatListeners.current.add(listener);
      return () => {
        chatListeners.current.delete(listener);
      };
    },
    [],
  );
  const sendChat = useCallback(
    async (input: ChatSend) => {
      const socket = socketRef.current;
      if (!socket?.connected)
        throw new Error(
          "Reconnect before sending. Your message is still in the composer.",
        );
      const payload = chatSendSchema.parse(input);
      if (payload.projectId !== projectId)
        throw new Error("This message belongs to another project.");
      let response: unknown;
      try {
        response = await socket
          .timeout(10000)
          .emitWithAck("chat:send", payload);
      } catch {
        throw new Error(
          "Your message could not be confirmed. Retry to confirm it without sending a duplicate.",
        );
      }
      const parsed = chatSendAckSchema.parse(response);
      if (!parsed.ok) throw new Error(parsed.error.message);
      return parsed.message;
    },
    [projectId],
  );
  const sendTyping = useCallback(
    (typing: boolean) => {
      const socket = socketRef.current;
      if (socket?.connected)
        socket.volatile.emit(
          "chat:typing",
          chatTypingSchema.parse({ projectId, typing }),
        );
    },
    [projectId],
  );
  return {
    ...connection,
    users,
    typingUsers,
    subscribeChat,
    sendChat,
    sendTyping,
    reconnect: () => setRetry((value) => value + 1),
  };
}
export type ProjectRealtime = ReturnType<typeof useProjectRealtime>;
