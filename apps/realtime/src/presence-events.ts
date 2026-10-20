import { getDatabase } from "@collab/db";
import {
  presenceUpdateAckSchema,
  presenceUpdateSchema,
  projectPresenceSchema,
  realtimeUserSchema,
  userColor,
  type PresenceMember,
} from "@collab/shared";
import { requireRealtimeAuthorization } from "./authorization.ts";
import type { TreeServer } from "./tree-events.ts";

export function configurePresenceEvents(io: TreeServer): () => void {
  const pending = new Set<string>();
  let publishing = false;
  let stopped = false;

  async function publish(projectId: string) {
    const members = new Map<string, PresenceMember>();
    const sockets = [...io.of("/").sockets.values()].filter(
      (socket) => socket.data.projectId === projectId && socket.data.presence,
    );
    const locations = new Map(
      sockets.map((socket) => [socket.id, socket.data.presence]),
    );
    let superseded = false;
    const pages = await getDatabase().item.findMany({
      where: { projectId, type: { in: ["PAGE", "CODE"] } },
      select: { id: true },
    });
    const pageIds = new Set(pages.map((page) => page.id));
    // Revalidate every recipient before exposing names or page locations.
    // The periodic audit also removes expired sessions and revoked members
    // when nobody is actively sending socket events.
    await Promise.all(
      sockets.map(async (socket) => {
        try {
          const authorization = await requireRealtimeAuthorization(
            socket.data.token,
            projectId,
          );
          const candidate = {
            id: authorization.user.id,
            name: authorization.user.name.trim().slice(0, 80) || "Collaborator",
            image: authorization.user.image,
            color: userColor(authorization.user.id),
          };
          const parsed = realtimeUserSchema.safeParse(candidate);
          const user = realtimeUserSchema.parse(
            parsed.success ? parsed.data : { ...candidate, image: null },
          );
          const presence = socket.data.presence;
          if (!socket.connected || !presence) return;
          // A page can be created and opened while this snapshot is querying.
          // Rebuild instead of clearing the newer location against older pages.
          if (presence !== locations.get(socket.id)) {
            superseded = true;
            return;
          }
          presence.user = user;
          if (presence.itemId && !pageIds.has(presence.itemId))
            presence.itemId = null;
          const member = members.get(user.id) ?? {
            user,
            itemIds: [],
            viewingOverview: false,
          };
          if (presence.itemId) {
            if (!member.itemIds.includes(presence.itemId))
              member.itemIds.push(presence.itemId);
          } else member.viewingOverview = true;
          members.set(user.id, member);
        } catch {
          delete socket.data.presence;
          socket.disconnect(true);
        }
      }),
    );
    if (superseded) {
      changed(projectId);
      return;
    }
    const event = projectPresenceSchema.parse({
      projectId,
      users: [...members.values()]
        .map((member) => ({ ...member, itemIds: member.itemIds.sort() }))
        .sort(
          (left, right) =>
            left.user.name.localeCompare(right.user.name) ||
            left.user.id.localeCompare(right.user.id),
        ),
    });
    for (const socket of sockets) {
      if (socket.connected && socket.data.presence)
        socket.emit("presence:changed", event);
    }
  }

  function changed(projectId: string) {
    if (stopped) return;
    pending.add(projectId);
    if (publishing) return;
    publishing = true;
    // Serialize snapshots so a slower earlier query cannot resurrect a closed
    // tab or replace a newer page location on clients.
    void (async () => {
      try {
        while (!stopped && pending.size) {
          const nextProject = pending.values().next().value;
          if (!nextProject) break;
          pending.delete(nextProject);
          try {
            await publish(nextProject);
          } catch {
            // Fail closed if the database cannot verify current membership.
            for (const socket of io.of("/").sockets.values()) {
              if (socket.data.projectId === nextProject)
                socket.disconnect(true);
            }
          }
        }
      } finally {
        publishing = false;
      }
    })();
  }

  io.on("connection", (socket) => {
    let updates = Promise.resolve();
    socket.on("presence:update", (input, acknowledge) => {
      updates = updates.then(async () => {
        try {
          const { projectId, itemId } = presenceUpdateSchema.parse(input);
          const authorization = await requireRealtimeAuthorization(
            socket.data.token,
            projectId,
            itemId ?? undefined,
          );
          if (!socket.connected) return;
          const candidate = {
            id: authorization.user.id,
            name: authorization.user.name.trim().slice(0, 80) || "Collaborator",
            image: authorization.user.image,
            color: userColor(authorization.user.id),
          };
          const parsed = realtimeUserSchema.safeParse(candidate);
          socket.data.presence = {
            user: realtimeUserSchema.parse(
              parsed.success ? parsed.data : { ...candidate, image: null },
            ),
            itemId,
          };
          changed(projectId);
          if (typeof acknowledge === "function")
            acknowledge(presenceUpdateAckSchema.parse({ ok: true }));
        } catch {
          if (typeof acknowledge === "function")
            acknowledge(
              presenceUpdateAckSchema.parse({
                ok: false,
                error: {
                  code: "FORBIDDEN",
                  message: "This page presence is not authorized.",
                },
              }),
            );
        }
      });
    });
    socket.on("disconnect", () => {
      delete socket.data.presence;
      changed(socket.data.projectId);
    });
  });

  const audit = setInterval(() => {
    const projects = new Set(
      [...io.of("/").sockets.values()]
        .filter((socket) => socket.data.presence)
        .map((socket) => socket.data.projectId),
    );
    for (const projectId of projects) changed(projectId);
  }, 3_000);
  audit.unref();
  return () => {
    stopped = true;
    clearInterval(audit);
    pending.clear();
  };
}
