import "./monitoring.ts";
import { Server as SocketIOServer } from "socket.io";
import { structuredLog } from "@collab/server";
import { flushServerMonitoring } from "@collab/server/monitoring";
import {
  livenessRequestSchema,
  livenessResponseSchema,
  realtimeEnvironmentSchema,
} from "@collab/shared";
import { getDatabase } from "@collab/db";
import { createHocuspocusServer } from "./hocuspocus.ts";
import { configurePresenceEvents } from "./presence-events.ts";
import { configureChatEvents } from "./chat-events.ts";
import { handleRunNotification } from "./run-events.ts";
import {
  configureTreeEvents,
  handleTreeNotification,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type InterServerEvents,
  type SocketData,
} from "./tree-events.ts";

const environment = realtimeEnvironmentSchema.safeParse(process.env);
if (!environment.success) {
  structuredLog("realtime", "error", "realtime.failed", {
    code: "INVALID_CONFIGURATION",
  });
  process.exit(1);
}

const configuration = environment.data;
const origin = new URL(configuration.BETTER_AUTH_URL).origin;
const server = createHocuspocusServer(async (request, response) => {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");

  const input = livenessRequestSchema.safeParse({
    method: request.method,
    path: request.url,
  });
  if (!input.success) {
    if (request.method === "POST" && request.url === "/internal/run-event") {
      await handleRunNotification(
        request,
        response,
        io,
        configuration.REALTIME_INTERNAL_SECRET,
      );
      return;
    }
    if (request.method === "POST" && request.url === "/internal/tree-changed") {
      await handleTreeNotification(
        request,
        response,
        io,
        configuration.REALTIME_INTERNAL_SECRET,
      );
      return;
    }
    request.resume();
    response.writeHead(404);
    response.end(JSON.stringify({ code: "NOT_FOUND", message: "Not found." }));
    return;
  }

  response.writeHead(200);
  response.end(
    JSON.stringify(
      livenessResponseSchema.parse({
        service: "realtime",
        status: "ok",
        phase: 8,
      }),
    ),
  );
});

const io = new SocketIOServer<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>(server.httpServer, {
  cors: { origin, methods: ["GET", "POST"], credentials: true },
  maxHttpBufferSize: 16 * 1024,
  pingInterval: 2_000,
  pingTimeout: 3_000,
  destroyUpgrade: false,
  allowRequest: (request, callback) => {
    callback(
      null,
      request.headers.origin === undefined || request.headers.origin === origin,
    );
  },
});
configureTreeEvents(io);
const stopPresence = configurePresenceEvents(io);
const stopChat = configureChatEvents(io);
server.httpServer.requestTimeout = 10_000;
server.httpServer.headersTimeout = 10_000;
server.httpServer.on("error", () => {
  structuredLog("realtime", "error", "realtime.failed", {
    code: "LISTEN_FAILED",
  });
  process.exitCode = 1;
});
await server.listen();
structuredLog("realtime", "info", "realtime.started");

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  stopPresence();
  stopChat();
  io.disconnectSockets(true);
  await server.destroy();
  await new Promise<void>((resolve) => io.close(() => resolve()));
  await getDatabase().$disconnect();
  await flushServerMonitoring();
  structuredLog("realtime", "info", "realtime.stopped");
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
