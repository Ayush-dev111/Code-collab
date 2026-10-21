"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { io, type Socket } from "socket.io-client";
import { HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import {
  chatMessageSchema,
  chatSendAckSchema,
  chatSendSchema,
  chatTypingEventSchema,
  chatTypingSchema,
  presenceUpdateAckSchema,
  presenceUpdateSchema,
  projectPresenceSchema,
  runEventSchema,
  type ChatMessage,
  type ChatSend,
  type PresenceMember,
} from "@/lib/shared";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from "@/lib/realtime-events";

export function canLeaveSharedPage() {
  return window.dispatchEvent(
    new Event("collab:before-navigation", { cancelable: true }),
  );
}

type ProjectSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

// One Socket.IO connection per open project, plus one WebSocket shared by all
// of the project's documents. Both use the session cookie (same origin), so
// switching pages opens no new connection and fetches no token.
export function useProjectRealtime(projectId: string, itemId: string | null) {
  const client = useQueryClient();
  const socketRef = useRef<ProjectSocket | undefined>(undefined);
  const documentsRef = useRef<HocuspocusProviderWebsocket | undefined>(
    undefined,
  );
  const locationRef = useRef(itemId);
  const chatListeners = useRef(new Set<(message: ChatMessage) => void>());
  const [typingUsers, setTypingUsers] = useState<ChatMessage["user"][]>([]);
  const [users, setUsers] = useState<PresenceMember[]>([]);
  const [connection, setConnection] = useState<{
    connected: boolean;
    error: string | null;
  }>({ connected: false, error: null });

  const shareLocation = useCallback(
    (socket: ProjectSocket) => {
      socket.timeout(10000).emit(
        "presence:update",
        presenceUpdateSchema.parse({
          projectId,
          itemId: locationRef.current,
        }),
        (error: unknown, response: unknown) => {
          const parsed = presenceUpdateAckSchema.safeParse(response);
          if (error || !parsed.success || !parsed.data.ok)
            setConnection({
              connected: socket.connected,
              error: "Your page location could not be shared.",
            });
        },
      );
    },
    [projectId],
  );

  useEffect(() => {
    locationRef.current = itemId;
    const socket = socketRef.current;
    if (socket?.connected) shareLocation(socket);
  }, [itemId, shareLocation]);

  useEffect(() => {
    const socket: ProjectSocket = io({ auth: { projectId } });
    socketRef.current = socket;
    socket.on("connect", () => {
      setConnection({ connected: true, error: null });
      shareLocation(socket);
      // Catch up on anything missed while disconnected.
      void client.invalidateQueries({ queryKey: ["items", projectId] });
      void client.invalidateQueries({ queryKey: ["chat", projectId] });
    });
    socket.on("tree:changed", (event) => {
      if (event.projectId === projectId)
        void client.invalidateQueries({ queryKey: ["items", projectId] });
    });
    const refreshRuns = (payload: unknown) => {
      const parsed = runEventSchema.safeParse(payload);
      if (parsed.success && parsed.data.projectId === projectId)
        void client.invalidateQueries({
          queryKey: ["runs", projectId, parsed.data.itemId],
        });
    };
    socket.on("run:started", refreshRuns);
    socket.on("run:finished", refreshRuns);
    socket.on("chat:message", (payload) => {
      const parsed = chatMessageSchema.safeParse(payload);
      if (parsed.success && parsed.data.projectId === projectId)
        for (const listener of chatListeners.current) listener(parsed.data);
    });
    socket.on("chat:typing", (payload) => {
      const parsed = chatTypingEventSchema.safeParse(payload);
      if (parsed.success && parsed.data.projectId === projectId)
        setTypingUsers(parsed.data.users);
    });
    socket.on("presence:changed", (payload) => {
      const parsed = projectPresenceSchema.safeParse(payload);
      if (parsed.success && parsed.data.projectId === projectId)
        setUsers(parsed.data.users);
    });
    socket.on("disconnect", () => {
      setUsers([]);
      setTypingUsers([]);
      setConnection({ connected: false, error: null });
    });
    socket.on("connect_error", () =>
      setConnection({
        connected: false,
        error: "Live updates are unavailable. Check your access and reconnect.",
      }),
    );
    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      if (socketRef.current === socket) socketRef.current = undefined;
    };
  }, [client, projectId, shareLocation]);

  useEffect(
    () => () => {
      documentsRef.current?.destroy();
      documentsRef.current = undefined;
    },
    [projectId],
  );

  const documentSocket = useCallback(() => {
    if (!documentsRef.current) {
      const url = new URL("/yjs", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      documentsRef.current = new HocuspocusProviderWebsocket({
        url: url.toString(),
      });
    }
    return documentsRef.current;
  }, []);

  const subscribeChat = useCallback(
    (listener: (message: ChatMessage) => void) => {
      chatListeners.current.add(listener);
      return () => {
        chatListeners.current.delete(listener);
      };
    },
    [],
  );

  const sendChat = useCallback(async (input: ChatSend) => {
    const socket = socketRef.current;
    if (!socket?.connected)
      throw new Error(
        "Reconnect before sending. Your message is still in the composer.",
      );
    const payload = chatSendSchema.parse(input);
    let response: unknown;
    try {
      response = await socket.timeout(10000).emitWithAck("chat:send", payload);
    } catch {
      throw new Error(
        "Your message could not be confirmed. Retry to confirm it without sending a duplicate.",
      );
    }
    const parsed = chatSendAckSchema.parse(response);
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.message;
  }, []);

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

  const reconnect = useCallback(() => {
    socketRef.current?.disconnect().connect();
  }, []);

  return {
    ...connection,
    users,
    typingUsers,
    documentSocket,
    subscribeChat,
    sendChat,
    sendTyping,
    reconnect,
  };
}
export type ProjectRealtime = ReturnType<typeof useProjectRealtime>;
