import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { io, type Socket } from "socket.io-client";
import { getDatabase } from "@collab/db";
import { createRedisFixture } from "./test-support/redis-fixture.ts";
import {
  chatHistoryResponseSchema,
  chatMessageSchema,
  chatSendAckSchema,
  chatTypingEventSchema,
  createdProjectResponseSchema,
  realtimeTokenResponseSchema,
  treeSubscribeAckSchema,
  type ChatSend,
  type ChatMessage,
} from "@collab/shared";

const database = getDatabase();
const runId = randomUUID();
const names = ["owner", "editor", "viewer", "outsider"] as const;
type Identity = (typeof names)[number];
const emails = names.map((name) => `phase7-${runId}-${name}@example.test`);
const password = `Phase7-${randomBytes(24).toString("hex")}`;
const children: ChildProcess[] = [];
const sockets: Socket[] = [];
const accounts = new Map<Identity, Client>();
const projects: string[] = [];
let environment = process.env;
let baseUrl = "";
let realtimeUrl = "";
let childLogs = "";
let cleanupAllowed = false;
// Phase 7 deliberately sends a large history burst. Phase 8 separately tests
// production quotas; this protocol fixture keeps the earlier history checks.
const rateLimitFixture = await createRedisFixture(true);
class Client {
  private cookies = new Map<string, string>();
  async request(path: string, body?: unknown) {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(new URL(path, baseUrl), {
        method: body === undefined ? "GET" : "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
        headers: {
          Cookie: [...this.cookies]
            .map(([key, value]) => `${key}=${value}`)
            .join("; "),
          ...(body === undefined
            ? {}
            : { Origin: baseUrl, "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      for (const entry of response.headers.getSetCookie()) {
        const pair = entry.split(";")[0]!;
        const split = pair.indexOf("=");
        this.cookies.set(pair.slice(0, split), pair.slice(split + 1));
      }
      const result = {
        status: response.status,
        body: (await response.json().catch(() => null)) as unknown,
      };
      if (
        path.startsWith("/api/auth/") &&
        result.status === 429 &&
        attempt < 3
      ) {
        const seconds = Number(
          response.headers.get("retry-after") ??
            response.headers.get("x-retry-after"),
        );
        assert.ok(Number.isFinite(seconds) && seconds <= 30);
        await delay(Math.max(1, seconds) * 1000 + 100);
        continue;
      }
      return result;
    }
  }
}
function client(name: Identity) {
  const value = accounts.get(name);
  assert.ok(value);
  return value;
}
async function until(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeout = 15000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
function start(entry: string, args: string[], cwd: string) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    env: environment,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr])
    stream?.on("data", (chunk: Buffer) => {
      childLogs = (childLogs + chunk.toString()).slice(-10000);
    });
  children.push(child);
  return child;
}
const webDirectory = fileURLToPath(new URL("..", import.meta.url));
function startRealtime() {
  return start(
    fileURLToPath(new URL("../../realtime/dist/index.js", import.meta.url)),
    [],
    fileURLToPath(new URL("../../realtime", import.meta.url)),
  );
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill();
  await exited;
}
async function connect(name: Identity, projectId: string) {
  const token = realtimeTokenResponseSchema.parse(
    (await client(name).request("/api/realtime-token", { projectId })).body,
  );
  const socket = io(token.url, {
    auth: { token: token.token },
    transports: ["websocket"],
    reconnection: false,
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  assert.equal(
    treeSubscribeAckSchema.parse(
      (await socket
        .timeout(5000)
        .emitWithAck("tree:subscribe", { projectId })) as unknown,
    ).ok,
    true,
  );
  return socket;
}
async function send(socket: Socket, input: unknown) {
  return chatSendAckSchema.parse(
    (await socket.timeout(10000).emitWithAck("chat:send", input)) as unknown,
  );
}
async function history(name: Identity, projectId: string, before?: string) {
  const result = await client(name).request(
    `/api/projects/${projectId}/chat${before ? `?before=${before}` : ""}`,
  );
  assert.equal(result.status, 200);
  return chatHistoryResponseSchema.parse(result.body);
}
async function run() {
  assert.equal(
    await database.user.count({ where: { email: { in: emails } } }),
    0,
  );
  cleanupAllowed = true;
  const appPort = await freePort();
  const realtimePort = await freePort();
  baseUrl = `http://127.0.0.1:${appPort}`;
  realtimeUrl = `http://127.0.0.1:${realtimePort}`;
  environment = {
    ...process.env,
    NODE_ENV: "production",
    BETTER_AUTH_URL: baseUrl,
    REALTIME_PORT: String(realtimePort),
    REALTIME_URL: `ws://127.0.0.1:${realtimePort}`,
    REALTIME_HTTP_URL: realtimeUrl,
    REDIS_URL: rateLimitFixture.url,
    SENTRY_DSN: "",
    NEXT_PUBLIC_SENTRY_DSN: "",
  };
  start(
    "scripts/next.ts",
    ["start", "--hostname", "127.0.0.1", "--port", String(appPort)],
    webDirectory,
  );
  let realtime = startRealtime();
  await until(
    async () => {
      try {
        return (
          (await fetch(`${baseUrl}/login`)).ok &&
          (await fetch(`${realtimeUrl}/health`)).ok
        );
      } catch {
        return false;
      }
    },
    "isolated apps ready",
    30000,
  );
  for (const [index, name] of names.entries()) {
    const account = new Client();
    accounts.set(name, account);
    assert.equal(
      (
        await account.request("/api/auth/sign-up/email", {
          name: `Chat ${name}`,
          email: emails[index],
          password,
        })
      ).status,
      200,
    );
  }
  const project = createdProjectResponseSchema.parse(
    (
      await client("owner").request("/api/projects", {
        name: `Phase 7 ${runId}`,
      })
    ).body,
  ).project;
  const otherProject = createdProjectResponseSchema.parse(
    (
      await client("outsider").request("/api/projects", {
        name: `Other chat ${runId}`,
      })
    ).body,
  ).project;
  projects.push(project.id, otherProject.id);
  const users = await database.user.findMany({
    where: { email: { in: emails } },
    select: { id: true, email: true },
  });
  const userId = (name: Identity) => {
    const user = users.find((row) => row.email === emails[names.indexOf(name)]);
    assert.ok(user);
    return user.id;
  };
  for (const name of ["editor", "viewer"] as const)
    await database.projectMember.create({
      data: {
        projectId: project.id,
        userId: userId(name),
        role: name === "editor" ? "EDITOR" : "VIEWER",
      },
    });
  assert.equal(
    (await new Client().request(`/api/projects/${project.id}/chat`)).status,
    401,
  );
  assert.equal(
    (await client("outsider").request(`/api/projects/${project.id}/chat`))
      .status,
    403,
  );
  assert.equal(
    (
      await client("owner").request(
        `/api/projects/${project.id}/chat?unknown=true`,
      )
    ).status,
    400,
  );
  const peers = await Promise.all(
    (["owner", "editor", "viewer"] as const).map((name) =>
      connect(name, project.id),
    ),
  );
  const other = await connect("outsider", otherProject.id);
  const received = peers.map(() => [] as ChatMessage[]);
  peers.forEach((socket, index) =>
    socket.on("chat:message", (event: unknown) =>
      received[index]!.push(chatMessageSchema.parse(event)),
    ),
  );
  const foreign: ChatMessage[] = [];
  other.on("chat:message", (event: unknown) =>
    foreign.push(chatMessageSchema.parse(event)),
  );
  const input: ChatSend = {
    projectId: project.id,
    clientMessageId: randomUUID(),
    body: "Hello team <script>window.chatInjected=true</script>",
  };
  for (const body of ["", " ", "x".repeat(2001)])
    assert.equal((await send(peers[0]!, { ...input, body })).ok, false);
  assert.equal(
    (
      await send(peers[0]!, {
        ...input,
        userId: userId("editor"),
        createdAt: new Date().toISOString(),
      })
    ).ok,
    false,
  );
  assert.equal(
    (await send(peers[0]!, { ...input, projectId: otherProject.id })).ok,
    false,
  );
  assert.equal((await send(peers[2]!, input)).ok, false);
  assert.equal((await send(other, input)).ok, false);
  assert.equal(
    await database.chatMessage.count({ where: { projectId: project.id } }),
    0,
  );
  console.log(
    "PASS anonymous/foreign history and viewer/foreign/forged/invalid sends are rejected before persistence",
  );
  const started = performance.now();
  const result = await send(peers[0]!, input);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Send rejected");
  await until(
    () =>
      received.every((events) =>
        events.some((message) => message.id === result.message.id),
      ),
    "all-role delivery",
    1000,
  );
  const latency = performance.now() - started;
  assert.ok(latency < 1000, `Delivery took ${latency} ms`);
  assert.equal(result.message.user.id, userId("owner"));
  assert.equal(foreign.length, 0);
  const duplicates = await Promise.all([
    send(peers[0]!, input),
    send(peers[0]!, input),
  ]);
  assert.ok(
    duplicates.every((ack) => ack.ok && ack.message.id === result.message.id),
  );
  assert.equal(
    (await send(peers[0]!, { ...input, body: "different text" })).ok,
    false,
  );
  assert.equal(
    await database.chatMessage.count({ where: { projectId: project.id } }),
    1,
  );
  assert.ok(received.every((events) => events.length === 1));
  console.log(
    `PASS messages are saved, reach owner/editor/viewer in ${Math.round(latency)} ms, stay project-scoped and retry without duplicate rows or broadcasts`,
  );
  const typing: unknown[][] = peers.map(() => []);
  peers.forEach((socket, index) =>
    socket.on("chat:typing", (event: unknown) =>
      typing[index]!.push(chatTypingEventSchema.parse(event)),
    ),
  );
  assert.deepEqual(
    (await peers[1]!.timeout(5000).emitWithAck("chat:typing", {
      projectId: project.id,
      typing: true,
    })) as unknown,
    { ok: true },
  );
  await until(
    () =>
      typing.every((events) =>
        events.some((event) =>
          chatTypingEventSchema
            .parse(event)
            .users.some((user) => user.id === userId("editor")),
        ),
      ),
    "typing reaches all roles",
  );
  assert.equal(
    (
      (await peers[2]!.timeout(5000).emitWithAck("chat:typing", {
        projectId: project.id,
        typing: true,
      })) as { ok: boolean }
    ).ok,
    false,
  );
  await until(
    () =>
      typing.every(
        (events) =>
          events.length > 1 &&
          chatTypingEventSchema.parse(events.at(-1)).users.length === 0,
      ),
    "typing expires",
    6500,
  );
  console.log(
    "PASS trusted typing names reach viewers and expire automatically; viewers cannot publish typing",
  );
  const timestamp = new Date(Date.now() - 60000);
  await database.chatMessage.createMany({
    data: Array.from({ length: 55 }, (_, index) => ({
      projectId: project.id,
      userId: userId("owner"),
      body: `Older ${index}`,
      createdAt: timestamp,
    })),
  });
  const first = await history("viewer", project.id);
  assert.equal(first.messages.length, 50);
  assert.ok(first.nextCursor);
  const second = await history("viewer", project.id, first.nextCursor);
  assert.equal(second.messages.length, 6);
  assert.equal(second.nextCursor, null);
  const ids = [...first.messages, ...second.messages].map(
    (message) => message.id,
  );
  assert.equal(new Set(ids).size, 56);
  await database.chatMessage.create({
    data: {
      projectId: otherProject.id,
      userId: userId("outsider"),
      body: "Private",
    },
  });
  const foreignCursor = (await history("outsider", otherProject.id))
    .messages[0]!.id;
  assert.equal(
    (
      await client("viewer").request(
        `/api/projects/${project.id}/chat?before=${foreignCursor}`,
      )
    ).status,
    400,
  );
  const late = await connect("viewer", project.id);
  assert.equal(
    (await history("viewer", project.id)).messages[0]!.id,
    result.message.id,
  );
  late.disconnect();
  peers[2]!.disconnect();
  const missed = await send(peers[1]!, {
    ...input,
    clientMessageId: randomUUID(),
    body: "While you were away",
  });
  assert.ok(missed.ok);
  const restored = await connect("viewer", project.id);
  assert.equal(
    (await history("viewer", project.id)).messages[0]!.body,
    "While you were away",
  );
  console.log(
    "PASS late joins/reconnects restore history, newest 50 and older cursor pages have no gaps with equal timestamps, and foreign cursors fail",
  );
  for (const socket of sockets) socket.disconnect();
  await stop(realtime);
  realtime = startRealtime();
  await until(async () => {
    try {
      return (await fetch(`${realtimeUrl}/health`)).ok;
    } catch {
      return false;
    }
  }, "realtime restarted");
  const freshOwner = await connect("owner", project.id);
  const freshViewer = await connect("viewer", project.id);
  assert.equal(
    (await history("viewer", project.id)).messages[0]!.body,
    "While you were away",
  );
  const postRestart = await send(freshOwner, {
    ...input,
    clientMessageId: randomUUID(),
    body: "After restart",
  });
  assert.ok(postRestart.ok);
  await database.projectMember.delete({
    where: {
      projectId_userId: { projectId: project.id, userId: userId("viewer") },
    },
  });
  const revokedEvents: unknown[] = [];
  freshViewer.on("chat:message", (event: unknown) => revokedEvents.push(event));
  assert.ok(
    (
      await send(freshOwner, {
        ...input,
        clientMessageId: randomUUID(),
        body: "After revocation",
      })
    ).ok,
  );
  await until(() => !freshViewer.connected, "revoked recipient disconnected");
  assert.equal(revokedEvents.length, 0);
  assert.equal(
    (await client("viewer").request(`/api/projects/${project.id}/chat`)).status,
    403,
  );
  await database.projectMember.update({
    where: {
      projectId_userId: { projectId: project.id, userId: userId("editor") },
    },
    data: { role: "VIEWER" },
  });
  const downgraded = await connect("editor", project.id);
  assert.equal(
    (await send(downgraded, { ...input, clientMessageId: randomUUID() })).ok,
    false,
  );
  assert.equal((await send(freshOwner, input)).ok, true);
  assert.equal(
    await database.chatMessage.count({
      where: { projectId: project.id, clientMessageId: input.clientMessageId },
    }),
    1,
  );
  console.log(
    "PASS history and duplicate-send protection survive process replacement; current role changes and revocation stop sends and delivery",
  );
  restored.disconnect();
  if (process.argv.includes("--browser")) {
    const child = start(
      "scripts/phase3-browser-smoke.ts",
      ["--phase7"],
      webDirectory,
    );
    child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error("Phase 7 browser acceptance failed")),
      );
    });
    console.log(
      "PASS real-browser chat acceptance and Phase 3/4/5 regressions",
    );
  }
}
try {
  await run();
  console.log("Phase 7 acceptance passed.");
} catch (error) {
  process.exitCode = 1;
  console.error(
    error instanceof Error ? error.message : "Phase 7 smoke failed",
  );
  let safeLogs = childLogs;
  for (const [key, value] of Object.entries(environment))
    if (value && /SECRET|TOKEN|PASSWORD|DATABASE_URL|REDIS_URL/.test(key))
      safeLogs = safeLogs.split(value).join("[redacted]");
  console.error(safeLogs);
} finally {
  for (const socket of sockets) socket.disconnect();
  for (const child of children) await stop(child);
  await rateLimitFixture.close();
  if (cleanupAllowed) {
    await database.project.deleteMany({
      where: { id: { in: projects }, owner: { email: { in: emails } } },
    });
    await database.user.deleteMany({ where: { email: { in: emails } } });
  }
  await database.$disconnect();
}
