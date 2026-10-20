import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createRedisFixture } from "./redis-fixture.ts";

export async function startTestStack(useFixture: boolean) {
  const fixture = useFixture ? await createRedisFixture() : undefined;
  const appPort = await freePort();
  const realtimePort = await freePort();
  const baseUrl = `http://127.0.0.1:${appPort}`;
  const realtimeUrl = `http://127.0.0.1:${realtimePort}`;
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "production",
    BETTER_AUTH_URL: baseUrl,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    REALTIME_HOST: "127.0.0.1",
    REALTIME_PORT: String(realtimePort),
    REALTIME_HTTP_URL: realtimeUrl,
    REALTIME_URL: `ws://127.0.0.1:${realtimePort}`,
    REALTIME_TOKEN_SECRET: randomBytes(32).toString("hex"),
    REALTIME_INTERNAL_SECRET: randomBytes(32).toString("hex"),
    SENTRY_DSN: "",
    NEXT_PUBLIC_SENTRY_DSN: "",
    SENTRY_AUTH_TOKEN: "",
    S3_ENDPOINT: "",
    S3_BUCKET: "",
    S3_ACCESS_KEY_ID: "",
    S3_SECRET_ACCESS_KEY: "",
    S3_SESSION_TOKEN: "",
    JUDGE0_URL: "",
    JUDGE0_AUTH_TOKEN: "",
    COLLAB_E2E_BASE_URL: baseUrl,
    COLLAB_E2E_PREFIX: randomUUID(),
    ...(fixture ? { REDIS_URL: fixture.url } : {}),
  };
  // Playwright sets its own color mode; avoid Node's conflicting env warning.
  delete environment.NO_COLOR;
  const webDirectory = fileURLToPath(new URL("../..", import.meta.url));
  const children: ChildProcess[] = [];
  let logs = "";
  function start(entry: string, args: string[], cwd = webDirectory) {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd,
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (chunk: Buffer) => {
        logs = (logs + chunk.toString()).slice(-20000);
      });
    children.push(child);
    return child;
  }
  async function stop() {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      child.kill();
      await exited;
    }
    await fixture?.close();
  }
  function safeLogs() {
    let value = logs;
    for (const [key, secret] of Object.entries(environment))
      if (secret && /SECRET|TOKEN|PASSWORD|DATABASE_URL|REDIS_URL/.test(key))
        value = value.split(secret).join("[redacted]");
    return value;
  }
  try {
    start("scripts/next.ts", [
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(appPort),
    ]);
    start(
      fileURLToPath(
        new URL("../../../realtime/dist/index.js", import.meta.url),
      ),
      [],
      fileURLToPath(new URL("../../../realtime", import.meta.url)),
    );
    const deadline = Date.now() + 30000;
    let ready = false;
    while (Date.now() < deadline) {
      try {
        ready =
          (
            await fetch(`${baseUrl}/login`, {
              signal: AbortSignal.timeout(1500),
            })
          ).ok &&
          (
            await fetch(`${realtimeUrl}/health`, {
              signal: AbortSignal.timeout(1500),
            })
          ).ok;
      } catch {
        /* Startup retries. */
      }
      if (ready) break;
      await delay(100);
    }
    if (!ready)
      throw new Error("The isolated test servers did not become ready.");
    return {
      baseUrl,
      realtimeUrl,
      environment,
      fixture,
      webDirectory,
      start,
      stop,
      safeLogs,
    };
  } catch (error) {
    await stop();
    throw new Error(
      `${error instanceof Error ? error.message : "Test setup failed"}\n${safeLogs()}`,
    );
  }
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address !== "object")
    throw new Error("No local port.");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
export type TestStack = Awaited<ReturnType<typeof startTestStack>>;
