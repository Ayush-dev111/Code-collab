import type { ServerToClientEvents } from "@/lib/realtime-events";

// API routes and the realtime server run in the same process but load modules
// separately, so the realtime server registers itself on globalThis.
export interface RealtimeBus {
  emitToProject<Event extends keyof ServerToClientEvents>(
    projectId: string,
    event: Event,
    ...payload: Parameters<ServerToClientEvents[Event]>
  ): void;
}

const store = globalThis as typeof globalThis & {
  collabRealtime?: RealtimeBus;
};

export function registerRealtimeBus(bus: RealtimeBus) {
  store.collabRealtime = bus;
}

export function emitToProject<Event extends keyof ServerToClientEvents>(
  projectId: string,
  event: Event,
  ...payload: Parameters<ServerToClientEvents[Event]>
) {
  store.collabRealtime?.emitToProject(projectId, event, ...payload);
}
