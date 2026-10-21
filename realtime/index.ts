import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type RawData } from "ws";
import { registerRealtimeBus } from "@/lib/realtime-bus";
import { toHeaders } from "./auth";
import { createHocuspocus } from "./hocuspocus";
import { createSocketServer } from "./socket";

function bytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(data);
}

// Adds live editing (Yjs over /yjs) and Socket.IO (/socket.io) to the same
// HTTP server that serves Next.js, so the whole app is one process and port.
export function attachRealtime(httpServer: HttpServer, origin: string) {
  const hocuspocus = createHocuspocus();
  const documents = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    // Socket.IO and Next.js (dev reload) handle their own upgrade paths.
    if (pathname !== "/yjs") return;
    if (
      request.headers.origin !== undefined &&
      request.headers.origin !== origin
    ) {
      socket.destroy();
      return;
    }
    documents.handleUpgrade(request, socket, head, (webSocket) => {
      const connection = hocuspocus.handleConnection(
        webSocket,
        new Request(new URL(request.url ?? "/yjs", origin), {
          headers: toHeaders(request.headers),
        }),
      );
      webSocket.on("message", (data) => connection.handleMessage(bytes(data)));
      webSocket.on("close", (code, reason) =>
        connection.handleClose({
          code,
          reason: reason.toString(),
        } as CloseEvent),
      );
      webSocket.on("error", () => webSocket.terminate());
    });
  });

  const sockets = createSocketServer(httpServer, origin);
  registerRealtimeBus({ emitToProject: sockets.emitToProject });

  return {
    // Saves every open document before the process exits.
    async close() {
      hocuspocus.closeConnections();
      hocuspocus.flushPendingStores();
      const deadline = Date.now() + 5000;
      while (hocuspocus.getDocumentsCount() > 0 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 100));
      documents.close();
      await sockets.close();
    },
  };
}
