import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getDatabase } from "@collab/db";
import {
  livenessResponseSchema,
  realtimeEnvironmentSchema,
} from "@collab/shared";
import { signRealtimeToken } from "@collab/shared/realtime-token";
import {
  HocuspocusProvider,
  HocuspocusProviderWebsocket,
} from "@hocuspocus/provider";
import * as Y from "yjs";

interface Probe {
  document: Y.Doc;
  provider: HocuspocusProvider;
  websocket: HocuspocusProviderWebsocket;
  failed: boolean;
  closed: boolean;
  destroyed: boolean;
}

interface ServerProcess {
  child: ChildProcess;
  exit: Promise<void>;
  exited: boolean;
  spawnError: Error | undefined;
}

const environment = realtimeEnvironmentSchema.parse(process.env);
const rootDirectory = resolve(import.meta.dirname, "../../..");
const realtimeDirectory = resolve(rootDirectory, "apps/realtime");
const serverEntry = resolve(realtimeDirectory, "dist/index.js");
const port = 3003;
const baseUrl = `http://127.0.0.1:${port}`;
const database = getDatabase();
const checkCode = process.argv.includes("--phase5");
const runId = randomUUID();
const userId = `phase3-restart-${runId}`;
const sessionId = `phase3-restart-session-${runId}`;
const email = `phase3-restart-${runId}@example.test`;
const field = checkCode ? "code" : "phase3-restart-smoke";
const probes = new Set<Probe>();
let fixture: { projectId: string; itemId: string } | undefined;
let running: ServerProcess | undefined;

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`${label}: timed out after ${timeoutMs} ms`);
}

async function requireFreePort(): Promise<void> {
  const probe = createServer();
  await new Promise<void>((accept, reject) => {
    probe.once("error", () =>
      reject(new Error(`Restart test requires free port ${port}.`)),
    );
    probe.listen(port, "127.0.0.1", () => {
      probe.close((error) => (error ? reject(error) : accept()));
    });
  });
}

async function startServer(): Promise<ServerProcess> {
  await requireFreePort();
  const child = spawn(process.execPath, [serverEntry], {
    cwd: realtimeDirectory,
    windowsHide: true,
    env: {
      ...process.env,
      REALTIME_HOST: "127.0.0.1",
      REALTIME_PORT: String(port),
      REALTIME_URL: `ws://127.0.0.1:${port}`,
      REALTIME_HTTP_URL: baseUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const processState: ServerProcess = {
    child,
    exited: false,
    spawnError: undefined,
    exit: new Promise<void>((accept) => child.once("close", () => accept())),
  };
  running = processState;
  child.once("error", (error: Error) => {
    processState.spawnError = error;
  });
  child.once("exit", () => {
    processState.exited = true;
  });
  // Drain child logs without printing configuration, tokens or document content.
  child.stdout?.resume();
  child.stderr?.resume();
  await waitUntil(async () => {
    if (processState.spawnError)
      throw new Error("The isolated realtime process could not start.");
    if (processState.exited)
      throw new Error("The isolated realtime process exited before readiness.");
    try {
      const response = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(500),
      });
      const body: unknown = await response.json();
      return response.ok && livenessResponseSchema.parse(body).status === "ok";
    } catch {
      return false;
    }
  }, "Isolated realtime startup");
  return processState;
}

async function stopServer(processState: ServerProcess): Promise<void> {
  if (!processState.exited) {
    assert.ok(
      processState.child.kill("SIGTERM"),
      "The owned realtime child must accept termination.",
    );
  }
  try {
    await Promise.race([
      processState.exit,
      delay(10_000, undefined, { ref: false }).then(() => {
        throw new Error("The isolated realtime process did not stop.");
      }),
    ]);
  } catch (error) {
    processState.child.kill("SIGKILL");
    await processState.exit;
    throw error;
  } finally {
    if (running === processState) running = undefined;
  }
}

function freshProbe(projectId: string, itemId: string): Probe {
  const { token } = signRealtimeToken(
    { userId, sessionId, projectId, role: "OWNER" },
    {
      secret: environment.REALTIME_TOKEN_SECRET,
      issuer: environment.BETTER_AUTH_URL,
    },
  );
  const document = new Y.Doc();
  assert.equal(
    document.getText(field).length,
    0,
    "Each connection starts with an empty, uncached document.",
  );
  const websocket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${port}/yjs`,
    autoConnect: false,
    WebSocketPolyfill: globalThis.WebSocket,
    maxAttempts: 1,
    timeout: 5_000,
    messageReconnectTimeout: 30_000,
  });
  const probe: Probe = {
    document,
    websocket,
    provider: new HocuspocusProvider({
      websocketProvider: websocket,
      document,
      name: `item:${itemId}`,
      token,
      onAuthenticationFailed: () => {
        probe.failed = true;
      },
      onClose: () => {
        probe.closed = true;
      },
    }),
    failed: false,
    closed: false,
    destroyed: false,
  };
  probes.add(probe);
  probe.provider.attach();
  void websocket.connect();
  return probe;
}

function destroyProbe(probe: Probe): void {
  if (probe.destroyed) return;
  probe.destroyed = true;
  probe.provider.destroy();
  probe.websocket.destroy();
  probe.document.destroy();
  probes.delete(probe);
}

async function connect(projectId: string, itemId: string): Promise<Probe> {
  const probe = freshProbe(projectId, itemId);
  await waitUntil(
    () => probe.provider.isSynced || probe.failed || probe.closed,
    "Fresh Yjs synchronization",
  );
  assert.equal(probe.failed, false, "The seeded owner must authenticate.");
  assert.equal(probe.closed, false, "The new connection must remain open.");
  assert.equal(
    probe.provider.isSynced,
    true,
    "A fresh document must receive the stored state.",
  );
  await waitUntil(
    () => probe.provider.unsyncedChanges === 0,
    "Initial sync acknowledgement",
  );
  return probe;
}

async function persistedText(itemId: string): Promise<string | null> {
  const item = await database.item.findUnique({
    where: { id: itemId },
    select: { yjsState: true },
  });
  if (!item?.yjsState) return null;
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, item.yjsState);
    return document.getText(field).toString();
  } finally {
    document.destroy();
  }
}

async function seedFixture(): Promise<{ projectId: string; itemId: string }> {
  assert.equal(
    await database.user.count({ where: { OR: [{ id: userId }, { email }] } }),
    0,
    "The generated fixture identity must not exist.",
  );
  assert.equal(
    await database.session.count({ where: { id: sessionId } }),
    0,
    "The generated fixture session must not exist.",
  );
  return database.$transaction(async (transaction) => {
    const now = new Date();
    await transaction.user.create({
      data: {
        id: userId,
        email,
        name: "Restart smoke owner",
        createdAt: now,
        updatedAt: now,
      },
    });
    await transaction.session.create({
      data: {
        id: sessionId,
        userId,
        token: randomBytes(32).toString("hex"),
        expiresAt: new Date(Date.now() + 15 * 60_000),
        createdAt: now,
        updatedAt: now,
      },
    });
    const project = await transaction.project.create({
      data: {
        name: `Restart smoke ${runId}`,
        ownerId: userId,
        members: { create: { userId, role: "OWNER" } },
      },
    });
    const item = await transaction.item.create({
      data: {
        projectId: project.id,
        type: checkCode ? "CODE" : "PAGE",
        language: checkCode ? "python" : null,
        title: "Restart persistence probe",
      },
    });
    return { projectId: project.id, itemId: item.id };
  });
}

async function run(): Promise<void> {
  await access(serverEntry);
  await requireFreePort();
  fixture = await seedFixture();
  const { projectId, itemId } = fixture;
  const first = await startServer();
  const initial = await connect(projectId, itemId);
  const marker = `Persisted across an OS process restart: ${runId}`;
  initial.document.getText(field).insert(0, marker);
  await waitUntil(
    () => initial.provider.unsyncedChanges === 0,
    "Write acknowledgement",
  );
  await waitUntil(
    async () => (await persistedText(itemId)) === marker,
    "Debounced binary persistence",
  );
  console.log(
    "PASS acknowledged Yjs text persists while its client remains connected",
  );

  // On Windows, child.kill terminates the process rather than dispatching a
  // catchable SIGTERM. Persist before killing so this tests restart recovery
  // without making an unsupported claim about Windows signal delivery.
  await stopServer(first);
  destroyProbe(initial);
  const second = await startServer();
  const recovered = await connect(projectId, itemId);
  assert.equal(
    recovered.document.getText(field).toString(),
    marker,
    "A new OS process and uncached Y.Doc must recover the complete text.",
  );
  console.log(
    "PASS a new realtime process restores PostgreSQL state into a fresh Y.Doc",
  );

  const appended = " | latest edit before last-client disconnect";
  recovered.document.getText(field).insert(marker.length, appended);
  await waitUntil(
    () => recovered.provider.unsyncedChanges === 0,
    "Final write acknowledgement",
  );
  destroyProbe(recovered);
  await waitUntil(
    async () => (await persistedText(itemId)) === marker + appended,
    "Last-client disconnect persistence",
  );
  await stopServer(second);
  const third = await startServer();
  const final = await connect(projectId, itemId);
  assert.equal(
    final.document.getText(field).toString(),
    marker + appended,
    "The latest disconnected-client edit must also survive a second restart.",
  );
  console.log(
    "PASS latest text after last-client disconnect survives another process restart",
  );
  destroyProbe(final);
  await stopServer(third);
}

try {
  await run();
} catch (error) {
  console.error(
    "Phase 3 restart smoke failed:",
    error instanceof Error ? error.message : "Unknown failure",
  );
  process.exitCode = 1;
} finally {
  for (const probe of probes) destroyProbe(probe);
  if (running)
    await stopServer(running).catch(() => {
      process.exitCode = 1;
    });
  if (fixture) {
    const ownedFixture = fixture;
    await database.$transaction(async (transaction) => {
      await transaction.project.deleteMany({
        where: { id: ownedFixture.projectId, ownerId: userId },
      });
      await transaction.user.deleteMany({ where: { id: userId, email } });
    });
  }
  await database.$disconnect();
}
