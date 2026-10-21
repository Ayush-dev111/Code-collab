import type {
  ChatMessage,
  ChatSendAck,
  ChatTypingEvent,
  PresenceUpdateAck,
  ProjectPresence,
  RunEvent,
} from "@/lib/shared";

// Socket.IO events between the browser and the realtime server.
export interface ClientToServerEvents {
  "chat:send": (
    input: unknown,
    acknowledge: (result: ChatSendAck) => void,
  ) => void;
  "chat:typing": (input: unknown) => void;
  "presence:update": (
    input: unknown,
    acknowledge: (result: PresenceUpdateAck) => void,
  ) => void;
}

export interface ServerToClientEvents {
  "chat:message": (message: ChatMessage) => void;
  "chat:typing": (event: ChatTypingEvent) => void;
  "run:started": (event: RunEvent) => void;
  "run:finished": (event: RunEvent) => void;
  "presence:changed": (event: ProjectPresence) => void;
  "tree:changed": (event: { projectId: string; changedAt: string }) => void;
}
