import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDatabase } from "@collab/db";
import { runEventSchema, runNotificationSchema } from "@collab/shared";
import { requireRealtimeAuthorization } from "./authorization.ts";
import type { TreeServer } from "./tree-events.ts";

export async function handleRunNotification(
  request: IncomingMessage,
  response: ServerResponse,
  io: TreeServer,
  secret: string,
) {
  const provided = Buffer.from(request.headers.authorization ?? "", "utf8");
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const send = (status: number, body: unknown) => {
    response.writeHead(status);
    response.end(JSON.stringify(body));
  };
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    request.resume();
    send(401, { code: "UNAUTHENTICATED", message: "Not authorized." });
    return;
  }
  if (
    request.headers["content-type"]?.split(";")[0]?.trim() !==
    "application/json"
  ) {
    request.resume();
    send(415, { code: "INVALID_INPUT", message: "Send a JSON body." });
    return;
  }
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const input of request) {
      const chunk = Buffer.isBuffer(input)
        ? input
        : Buffer.from(input as Uint8Array);
      size += chunk.length;
      if (size > 4096) {
        send(413, {
          code: "BODY_TOO_LARGE",
          message: "The request is too large.",
        });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    }
    const payload = runNotificationSchema.parse(
      JSON.parse(
        new TextDecoder("utf8", { fatal: true }).decode(Buffer.concat(chunks)),
      ) as unknown,
    );
    const row = await getDatabase().run.findFirst({
      where: {
        id: payload.runId,
        item: { projectId: payload.projectId, type: "CODE" },
      },
      select: { id: true, itemId: true, status: true },
    });
    if (
      !row ||
      (payload.event === "run:started"
        ? row.status !== "RUNNING"
        : row.status === "RUNNING")
    )
      throw new Error("Invalid run state");
    const event = runEventSchema.parse({
      projectId: payload.projectId,
      itemId: row.itemId,
      runId: row.id,
      changedAt: new Date().toISOString(),
    });
    const recipients = await io
      .in(`project:${payload.projectId}`)
      .fetchSockets();
    await Promise.all(
      recipients.map(async (socket) => {
        try {
          await requireRealtimeAuthorization(
            socket.data.token,
            payload.projectId,
            row.itemId,
          );
          socket.emit(payload.event, event);
        } catch {
          socket.disconnect(true);
        }
      }),
    );
    send(200, { published: true });
  } catch {
    send(403, {
      code: "INVALID_NOTIFICATION",
      message: "The run notification was rejected.",
    });
  }
}
