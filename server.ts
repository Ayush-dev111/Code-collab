// Runs Next.js, live document editing and Socket.IO in one Node process.
//   npm run dev     development with hot reload
//   npm start       production (run `npm run build` first)
import { existsSync } from "node:fs";
import { createServer } from "node:http";

const production = process.argv.includes("--production");
Object.assign(process.env, {
  NODE_ENV: production ? "production" : "development",
});
if (existsSync(".env")) process.loadEnvFile(".env");

const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? (production ? "0.0.0.0" : "127.0.0.1");
const origin = new URL(
  process.env.BETTER_AUTH_URL ?? `http://${hostname}:${port}`,
).origin;

const { default: next } = await import("next");
const { attachRealtime } = await import("./realtime/index.ts");

const app = next({ dev: !production, hostname, port });
await app.prepare();
const handle = app.getRequestHandler();
const server = createServer(
  (request, response) => void handle(request, response),
);
const realtime = attachRealtime(server, origin);

server.listen(port, hostname, () => {
  console.log(
    `Collab is ready on ${origin} (${production ? "production" : "development"})`,
  );
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await realtime.close();
  server.close();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
