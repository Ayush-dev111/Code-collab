import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  createServer as httpServer,
  type Server as HttpServer,
} from "node:http";
import {
  createServer as tcpServer,
  type Server as TcpServer,
  type Socket as TcpSocket,
} from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { getDatabase } from "@collab/db";
import {
  createdProjectResponseSchema,
  itemResponseSchema,
  realtimeTokenResponseSchema,
  treeSubscribeAckSchema,
  runEventSchema,
  runResponseSchema,
  runHistoryResponseSchema,
  judge0LanguageIds,
  runnerEnvironmentSchema,
  type RunInput,
} from "@collab/shared";
import { io, type Socket } from "socket.io-client";

const realSandbox = process.argv.includes("--sandbox");
const browserChecks = process.argv.includes("--browser");
const database = getDatabase();
const runId = randomUUID();
const names = ["owner", "editor", "viewer", "outsider"] as const;
type Identity = (typeof names)[number];
const emails = names.map((name) => `phase6-${runId}-${name}@example.test`);
const password = `Phase6-${randomBytes(24).toString("hex")}`;
const authToken = randomBytes(32).toString("hex");
const children: ChildProcess[] = [];
const sockets: Socket[] = [];
const connections = new Set<TcpSocket>();
const accounts = new Map<Identity, Client>();
const projects: string[] = [];
let cleanupAllowed = false;
let baseUrl = "";
let realtimeUrl = "";
let judge: HttpServer | undefined;
let redis: TcpServer | undefined;
let childLogs = "";
let fixtureMode: "normal" | "hold" | "unavailable" | "bad-output" | "redirect" =
  "normal";
let redisUnavailable = false;
let submissionCount = 0;
const submissions = new Map<string, { code: string; stdin: string }>();
const counters = new Map<string, { value: number | string; expires: number }>();
let environment: NodeJS.ProcessEnv = process.env;

type ApiResult = { status: number; headers: Headers; body: unknown };
class Client {
  private cookies = new Map<string, string>();
  async request(
    path: string,
    method = "GET",
    body?: unknown,
    origin = baseUrl,
  ): Promise<ApiResult> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(new URL(path, baseUrl), {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(55_000),
        headers: {
          Cookie: [...this.cookies]
            .map(([key, value]) => `${key}=${value}`)
            .join("; "),
          ...(method === "GET"
            ? {}
            : { Origin: origin, "Content-Type": "application/json" }),
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
        headers: response.headers,
        body: (await response.json().catch(() => null)) as unknown,
      };
      if (
        path.startsWith("/api/auth/") &&
        result.status === 429 &&
        attempt < 3
      ) {
        const wait = Number(
          result.headers.get("x-retry-after") ??
            result.headers.get("retry-after"),
        );
        assert.ok(
          Number.isFinite(wait) && wait <= 30,
          "Auth retry must be bounded",
        );
        await delay(Math.max(1, wait) * 1000 + 100);
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
  timeout = 15_000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function listen(server: HttpServer | TcpServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return address.port;
}
async function freePort() {
  const server = tcpServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
function start(entry: string, args: string[], cwd: string) {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd,
    env: environment,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    childLogs = (childLogs + chunk.toString()).slice(-8000);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    childLogs = (childLogs + chunk.toString()).slice(-8000);
  });
  children.push(child);
  return child;
}

// The fixture returns protocol responses for these markers. It never interprets
// or executes any source. Only --sandbox submits to the configured Judge0 host.
const samples = {
  python: "print(input())\n",
  javascript:
    "const fs = require('fs'); console.log(fs.readFileSync(0, 'utf8').trim());\n",
  cpp: "#include <iostream>\n#include <string>\nint main(){std::string s;std::getline(std::cin,s);std::cout<<s<<'\\n';}\n",
  java: "import java.util.Scanner; public class Main { public static void main(String[] args) {System.out.println(new Scanner(System.in).nextLine());}}\n",
} as const;
const loopCode = "# loop\nwhile True:\n    pass\n";
async function fixtures() {
  judge = httpServer((request, response) => {
    void (async () => {
      if (request.headers["x-auth-token"] !== authToken) {
        response.writeHead(401).end();
        return;
      }
      if (fixtureMode === "unavailable") {
        response.writeHead(503).end();
        return;
      }
      if (fixtureMode === "redirect") {
        response
          .writeHead(302, { Location: "http://127.0.0.1:1/must-not-follow" })
          .end();
        return;
      }
      const url = new URL(request.url ?? "/", "http://fixture.test");
      response.setHeader("Content-Type", "application/json");
      if (url.pathname === "/languages") {
        response.end(
          JSON.stringify([
            { id: 71, name: "Python (3.8.1)" },
            { id: 63, name: "JavaScript (Node.js 12.14.0)" },
            { id: 54, name: "C++ (GCC 9.2.0)" },
            { id: 62, name: "Java (OpenJDK 13.0.1)" },
          ]),
        );
        return;
      }
      if (request.method === "POST" && url.pathname === "/submissions") {
        let text = "";
        for await (const chunk of request) text += String(chunk);
        const input: unknown = JSON.parse(text);
        assert.ok(input && typeof input === "object");
        const body = input as Record<string, unknown>;
        assert.equal(url.searchParams.get("base64_encoded"), "true");
        assert.equal(url.searchParams.get("wait"), "false");
        assert.equal(body.enable_network, false);
        assert.equal(body.cpu_time_limit, 2);
        assert.equal(body.cpu_extra_time, 0.5);
        assert.equal(body.wall_time_limit, 5);
        assert.equal(body.memory_limit, 256000);
        assert.equal(body.stack_limit, 64000);
        assert.equal(body.max_file_size, 64);
        assert.equal(body.max_processes_and_or_threads, 60);
        assert.equal(body.number_of_runs, 1);
        assert.equal(body.enable_per_process_and_thread_time_limit, false);
        assert.equal(body.enable_per_process_and_thread_memory_limit, false);
        assert.equal(body.redirect_stderr_to_stdout, false);
        for (const key of [
          "additional_files",
          "callback_url",
          "compiler_options",
          "command_line_arguments",
        ])
          assert.equal(body[key], undefined);
        assert.ok(
          Object.values(judge0LanguageIds).includes(body.language_id as 71),
        );
        assert.equal(typeof body.source_code, "string");
        assert.equal(typeof body.stdin, "string");
        const token = randomUUID();
        submissions.set(token, {
          code: Buffer.from(body.source_code as string, "base64").toString(
            "utf8",
          ),
          stdin: Buffer.from(body.stdin as string, "base64").toString("utf8"),
        });
        submissionCount += 1;
        response.writeHead(201).end(JSON.stringify({ token }));
        return;
      }
      const submission = submissions.get(url.pathname.split("/").at(-1) ?? "");
      if (!submission) {
        response.writeHead(404).end();
        return;
      }
      const { code, stdin } = submission;
      const status =
        fixtureMode === "hold"
          ? { id: 2, description: "Processing" }
          : code.includes("# loop")
            ? { id: 5, description: "Time Limit Exceeded" }
            : code.includes("compile-error")
              ? { id: 6, description: "Compilation Error" }
              : code.includes("stderr-marker")
                ? { id: 11, description: "Runtime Error (NZEC)" }
                : { id: 3, description: "Accepted" };
      const encode = (value: string) => Buffer.from(value).toString("base64");
      response.end(
        JSON.stringify({
          status,
          stdout:
            fixtureMode === "bad-output"
              ? "!==="
              : status.id === 3
                ? encode(
                    code.includes("20000")
                      ? "X".repeat(20000)
                      : `${stdin.trim()}\n`,
                  )
                : null,
          stderr: status.id === 11 ? encode("stderr-marker") : null,
          compile_output: status.id === 6 ? encode("compile-error") : null,
          exit_code: status.id === 3 ? 0 : status.id === 11 ? 1 : null,
          time: status.id === 5 ? "2.001" : "0.012",
        }),
      );
    })().catch(() => {
      response.writeHead(500).end();
      process.exitCode = 1;
    });
  });
  const judgePort = await listen(judge);
  // RESP2 fixture exercises the official client, key scope and fail-closed
  // behavior. Real Lua execution is separately covered by --sandbox + Redis.
  redis = tcpServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", () => undefined);
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      if (redisUnavailable) {
        socket.destroy();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        const parsed = parseCommand(buffer);
        if (!parsed) return;
        buffer = buffer.subarray(parsed.length);
        const [command, script, number, ...values] = parsed.args;
        if (command !== "EVAL") {
          socket.write("+OK\r\n");
          continue;
        }
        const count = Number(number);
        const keys = values.slice(0, count);
        const args = values.slice(count);
        for (const [key, value] of counters)
          if (value.expires <= Date.now()) counters.delete(key);
        if (script?.includes("collab-fixed-window-v1")) {
          const blocked = keys.find(
            (key, index) =>
              Number(counters.get(key)?.value ?? 0) >= Number(args[index + 1]),
          );
          if (blocked)
            socket.write(
              `*2\r\n:1\r\n:${Math.max(1, counters.get(blocked)!.expires - Date.now())}\r\n`,
            );
          else {
            for (const key of keys)
              counters.set(key, {
                value: Number(counters.get(key)?.value ?? 0) + 1,
                expires:
                  counters.get(key)?.expires ?? Date.now() + Number(args[0]),
              });
            socket.write("*2\r\n:0\r\n:0\r\n");
          }
        } else if (script?.includes("INCR")) {
          const user = Number(counters.get(keys[0]!)?.value ?? 0);
          const project = Number(counters.get(keys[1]!)?.value ?? 0);
          const blocked =
            user >= 6
              ? counters.get(keys[0]!)
              : project >= 20
                ? counters.get(keys[1]!)
                : undefined;
          const lease = counters.get(keys[2]!);
          if (blocked) {
            socket.write(
              `*2\r\n:1\r\n:${Math.max(1, blocked.expires - Date.now())}\r\n`,
            );
            continue;
          }
          if (lease) {
            socket.write(
              `*2\r\n:2\r\n:${Math.max(1, lease.expires - Date.now())}\r\n`,
            );
            continue;
          }
          counters.set(keys[0]!, {
            value: user + 1,
            expires: counters.get(keys[0]!)?.expires ?? Date.now() + 60000,
          });
          counters.set(keys[1]!, {
            value: project + 1,
            expires: counters.get(keys[1]!)?.expires ?? Date.now() + 60000,
          });
          counters.set(keys[2]!, {
            value: args[0]!,
            expires: Date.now() + Number(args[1]),
          });
          socket.write("*2\r\n:0\r\n:0\r\n");
        } else {
          const matches = counters.get(keys[0]!)?.value === args[0];
          if (matches) counters.delete(keys[0]!);
          socket.write(`:${matches ? 1 : 0}\r\n`);
        }
      }
    });
  });
  const redisPort = await listen(redis);
  return {
    JUDGE0_URL: `http://127.0.0.1:${judgePort}`,
    JUDGE0_AUTH_TOKEN: authToken,
    REDIS_URL: `redis://127.0.0.1:${redisPort}`,
  };
}
function parseCommand(
  buffer: Buffer,
): { args: string[]; length: number } | null {
  const firstEnd = buffer.indexOf("\r\n");
  if (firstEnd < 0) return null;
  assert.equal(buffer[0], 42);
  const count = Number(buffer.toString("ascii", 1, firstEnd));
  const args: string[] = [];
  let offset = firstEnd + 2;
  for (let i = 0; i < count; i += 1) {
    const end = buffer.indexOf("\r\n", offset);
    if (end < 0) return null;
    assert.equal(buffer[offset], 36);
    const length = Number(buffer.toString("ascii", offset + 1, end));
    if (buffer.length < end + 2 + length + 2) return null;
    args.push(buffer.toString("utf8", end + 2, end + 2 + length));
    offset = end + 2 + length + 2;
  }
  return { args, length: offset };
}

async function createCode(projectId: string, language: RunInput["language"]) {
  const result = await client("owner").request(
    `/api/projects/${projectId}/items`,
    "POST",
    { type: "CODE", title: `Run ${language}`, language },
  );
  assert.equal(result.status, 201);
  return itemResponseSchema.parse(result.body).item;
}
async function connect(name: Identity, projectId: string) {
  const token = realtimeTokenResponseSchema.parse(
    (await client(name).request("/api/realtime-token", "POST", { projectId }))
      .body,
  );
  const socket = io(token.url, {
    auth: { token: token.token },
    transports: ["websocket"],
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  const result = (await socket
    .timeout(10000)
    .emitWithAck("tree:subscribe", { projectId })) as unknown;
  assert.equal(treeSubscribeAckSchema.parse(result).ok, true);
  return socket;
}

async function run() {
  assert.equal(
    await database.user.count({ where: { email: { in: emails } } }),
    0,
  );
  cleanupAllowed = true;
  const runner = realSandbox
    ? runnerEnvironmentSchema.parse(process.env)
    : await fixtures();
  const appPort = await freePort();
  const realtimePort = await freePort();
  baseUrl = `http://127.0.0.1:${appPort}`;
  realtimeUrl = `http://127.0.0.1:${realtimePort}`;
  environment = {
    ...process.env,
    ...runner,
    NODE_ENV: "production",
    BETTER_AUTH_URL: baseUrl,
    REALTIME_PORT: String(realtimePort),
    REALTIME_URL: `ws://127.0.0.1:${realtimePort}`,
    REALTIME_HTTP_URL: realtimeUrl,
  };
  const webDirectory = fileURLToPath(new URL("..", import.meta.url));
  start(
    "scripts/next.ts",
    ["start", "--hostname", "127.0.0.1", "--port", String(appPort)],
    webDirectory,
  );
  start(
    fileURLToPath(new URL("../../realtime/dist/index.js", import.meta.url)),
    [],
    fileURLToPath(new URL("../../realtime", import.meta.url)),
  );
  await until(
    async () => {
      try {
        return (
          (await fetch(`${realtimeUrl}/health`)).ok &&
          (await fetch(`${baseUrl}/login`)).ok
        );
      } catch {
        return false;
      }
    },
    "isolated production apps ready",
    30000,
  );
  for (const [index, name] of names.entries()) {
    const account = new Client();
    accounts.set(name, account);
    assert.equal(
      (
        await account.request("/api/auth/sign-up/email", "POST", {
          name: `Runner ${name}`,
          email: emails[index],
          password,
        })
      ).status,
      200,
    );
  }
  const project = createdProjectResponseSchema.parse(
    (
      await client("owner").request("/api/projects", "POST", {
        name: `Phase 6 ${runId}`,
      })
    ).body,
  ).project;
  projects.push(project.id);
  for (const name of ["editor", "viewer"] as const) {
    const account = await database.user.findUniqueOrThrow({
      where: { email: emails[names.indexOf(name)]! },
    });
    await database.projectMember.create({
      data: {
        projectId: project.id,
        userId: account.id,
        role: name === "editor" ? "EDITOR" : "VIEWER",
      },
    });
  }
  const item = await createCode(project.id, "python");
  const input: RunInput = {
    projectId: project.id,
    itemId: item.id,
    language: "python",
    sourceCode: loopCode,
    stdin: "",
  };
  assert.equal(
    (await new Client().request("/api/run", "POST", input)).status,
    401,
  );
  assert.equal(
    (await client("viewer").request("/api/run", "POST", input)).status,
    403,
  );
  assert.equal(
    (await client("outsider").request("/api/run", "POST", input)).status,
    403,
  );
  assert.equal(
    (
      await client("owner").request(
        "/api/run",
        "POST",
        input,
        "https://foreign.example",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await client("owner").request("/api/run", "POST", {
        ...input,
        enable_network: true,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await client("owner").request("/api/run", "POST", {
        ...input,
        language: "javascript",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await client("owner").request("/api/run", "POST", {
        ...input,
        sourceCode: "X".repeat(65537),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await client("owner").request("/api/run", "POST", {
        ...input,
        stdin: "🙂".repeat(5000),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await client("outsider").request(
        `/api/projects/${project.id}/items/${item.id}/runs`,
      )
    ).status,
    403,
  );
  assert.equal(await database.run.count({ where: { itemId: item.id } }), 0);
  console.log(
    "PASS run and history permissions, origins, language consistency and byte limits reject invalid requests before submission",
  );
  const peers = await Promise.all([
    connect("owner", project.id),
    connect("editor", project.id),
    connect("viewer", project.id),
  ]);
  const events = peers.map(() => ({
    started: new Set<string>(),
    finished: new Set<string>(),
  }));
  peers.forEach((socket, index) => {
    socket.on("run:started", (payload: unknown) =>
      events[index]!.started.add(runEventSchema.parse(payload).runId),
    );
    socket.on("run:finished", (payload: unknown) =>
      events[index]!.finished.add(runEventSchema.parse(payload).runId),
    );
  });
  if (!realSandbox) fixtureMode = "hold";
  const pending = client("owner").request("/api/run", "POST", input);
  await until(
    () => events.every((event) => event.started.size === 1),
    "shared started event",
  );
  const busy = await client("editor").request("/api/run", "POST", input);
  assert.equal(busy.status, 409);
  assert.ok(Number(busy.headers.get("retry-after")) > 0);
  assert.equal(
    runHistoryResponseSchema.parse(
      (
        await client("viewer").request(
          `/api/projects/${project.id}/items/${item.id}/runs`,
        )
      ).body,
    ).runs[0]?.status,
    "RUNNING",
  );
  if (!realSandbox) fixtureMode = "normal";
  const first = runResponseSchema.parse((await pending).body).run;
  assert.equal(first.judge0Status, 5);
  await until(
    () => events.every((event) => event.finished.has(first.id)),
    "shared finished event",
  );
  assert.equal(
    (await database.run.findUniqueOrThrow({ where: { id: first.id } }))
      .sourceCode,
    loopCode,
  );
  console.log(
    realSandbox
      ? "PASS real infinite loop is killed by Judge0 and all collaborators receive run events"
      : "PASS atomic per-file lease, persisted snapshot, pending history and all collaborator run events (protocol fixture)",
  );
  for (const language of ["python", "javascript", "cpp", "java"] as const) {
    const code = await createCode(project.id, language);
    const response = await client("owner").request("/api/run", "POST", {
      projectId: project.id,
      itemId: code.id,
      language,
      sourceCode: samples[language],
      stdin: "shared-stdin\n",
    });
    assert.equal(response.status, 201);
    const run = runResponseSchema.parse(response.body).run;
    assert.equal(run.judge0Status, 3);
    assert.equal(run.exitCode, 0);
    assert.equal(run.stdout?.trim(), "shared-stdin");
    assert.ok(run.durationMs !== null);
    const historyPath = `/api/projects/${project.id}/items/${code.id}/runs`;
    for (const identity of ["owner", "editor", "viewer"] as const)
      assert.deepEqual(
        runHistoryResponseSchema.parse(
          (await client(identity).request(historyPath)).body,
        ).runs[0],
        run,
      );
    await until(
      () =>
        events.every(
          (event) => event.started.has(run.id) && event.finished.has(run.id),
        ),
      "events reach all roles",
    );
  }
  console.log(
    realSandbox
      ? "PASS Python, JavaScript, C++ and Java execute with stdin and matching persisted output for owner, editor and viewer"
      : "PASS four runtime mappings, fixed sandbox constraints, stdin encoding and matching history for all roles (protocol fixture)",
  );
  const loop = await client("owner").request("/api/run", "POST", input);
  assert.equal(loop.status, 201);
  assert.equal(runResponseSchema.parse(loop.body).run.judge0Status, 5);
  const limited = await client("owner").request("/api/run", "POST", input);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  console.log(
    "PASS per-user run allowance returns 429 and Retry-After without submitting another run",
  );
  const java = await createCode(project.id, "java");
  const compile = await client("editor").request("/api/run", "POST", {
    ...input,
    itemId: java.id,
    language: "java",
    sourceCode: "// compile-error\npublic class Main { INVALID SYNTAX }",
  });
  assert.equal(compile.status, 201);
  const compileRun = runResponseSchema.parse(compile.body).run;
  assert.equal(compileRun.judge0Status, 6);
  assert.ok(compileRun.compileOutput);
  const js = await createCode(project.id, "javascript");
  const stderr = await client("editor").request("/api/run", "POST", {
    ...input,
    itemId: js.id,
    language: "javascript",
    sourceCode: "throw new Error('stderr-marker');",
  });
  const errorRun = runResponseSchema.parse(stderr.body).run;
  assert.equal(errorRun.exitCode, 1);
  assert.ok(errorRun.stderr?.includes("stderr-marker"));
  const large = await client("editor").request("/api/run", "POST", {
    ...input,
    sourceCode: 'print("X" * 20000)',
  });
  const largeRun = runResponseSchema.parse(large.body).run;
  assert.equal(largeRun.stdout?.length, 16384);
  assert.equal(largeRun.outputTruncated, true);
  console.log(
    "PASS compiler errors, stderr, nonzero exit codes and capped output persist in history",
  );
  if (!realSandbox) {
    for (const mode of ["unavailable", "bad-output", "redirect"] as const) {
      fixtureMode = mode;
      const result = await client("editor").request("/api/run", "POST", {
        ...input,
        sourceCode: samples.python,
      });
      assert.equal(result.status, 201);
      assert.equal(runResponseSchema.parse(result.body).run.status, "FAILED");
    }
    fixtureMode = "normal";
    const token = randomUUID();
    submissions.set(token, { code: samples.python, stdin: "recovered" });
    const account = await database.user.findUniqueOrThrow({
      where: { email: emails[0]! },
    });
    const stale = await database.run.create({
      data: {
        itemId: item.id,
        userId: account.id,
        language: "python",
        status: "RUNNING",
        judge0Token: token,
        createdAt: new Date(Date.now() - 70000),
      },
    });
    await client("viewer").request(
      `/api/projects/${project.id}/items/${item.id}/runs`,
    );
    assert.equal(
      (await database.run.findUniqueOrThrow({ where: { id: stale.id } }))
        .stdout,
      "recovered\n",
    );
    redisUnavailable = true;
    assert.equal(
      (await client("editor").request("/api/run", "POST", input)).status,
      503,
    );
    redisUnavailable = false;
    console.log(
      "PASS service failures, invalid output and redirects fail safely; stale runs recover from saved tokens and Redis outage disables execution",
    );
    const unauthorized = await fetch(`${realtimeUrl}/internal/run-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        runId: first.id,
        event: "run:finished",
      }),
    });
    assert.equal(unauthorized.status, 401);
    const wrongProject = await fetch(`${realtimeUrl}/internal/run-event`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.REALTIME_INTERNAL_SECRET}`,
      },
      body: JSON.stringify({
        projectId: "cforeignproject123456789",
        runId: first.id,
        event: "run:finished",
      }),
    });
    assert.equal(wrongProject.status, 403);
    assert.equal(submissionCount, 10);
  }
  const history = runHistoryResponseSchema.parse(
    (
      await client("viewer").request(
        `/api/projects/${project.id}/items/${item.id}/runs?before=${first.id}`,
      )
    ).body,
  );
  assert.ok(history.runs.every((row) => row.id !== first.id));
  assert.equal(
    (
      await client("viewer").request(
        `/api/projects/${project.id}/items/${item.id}/runs?before=${compileRun.id}`,
      )
    ).status,
    400,
  );
  await database.projectMember.delete({
    where: {
      projectId_userId: {
        projectId: project.id,
        userId: (
          await database.user.findUniqueOrThrow({
            where: { email: emails[2]! },
          })
        ).id,
      },
    },
  });
  assert.equal(
    (
      await client("viewer").request(
        `/api/projects/${project.id}/items/${item.id}/runs`,
      )
    ).status,
    403,
  );
  console.log(
    "PASS history cursors are scoped to their code file and revoked memberships lose history access",
  );
  if (browserChecks) {
    const child = start(
      "scripts/phase3-browser-smoke.ts",
      ["--phase6"],
      webDirectory,
    );
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error("Phase 6 browser acceptance failed")),
      );
    });
    console.log(
      "PASS real-browser Phase 6 run/output/history acceptance plus Phase 3/4/5 regressions",
    );
  }
}

try {
  await run();
  console.log(
    realSandbox
      ? "Phase 6 real sandbox acceptance passed."
      : "Phase 6 application integration passed against protocol fixtures. Real sandbox acceptance remains separate.",
  );
} catch (error) {
  process.exitCode = 1;
  console.error(
    error instanceof Error ? error.message : "Phase 6 smoke failed",
  );
  let safeLogs = childLogs;
  for (const [key, value] of Object.entries(environment ?? process.env))
    if (value && /SECRET|TOKEN|PASSWORD|DATABASE_URL|REDIS_URL/.test(key))
      safeLogs = safeLogs.split(value).join("[redacted]");
  console.error(safeLogs);
} finally {
  for (const socket of sockets) socket.disconnect();
  for (const child of children) {
    if (child.exitCode !== null) continue;
    const exited = new Promise<void>((resolve) =>
      child.once("exit", () => resolve()),
    );
    child.kill();
    await exited;
  }
  for (const connection of connections) connection.destroy();
  if (redis)
    await new Promise<void>((resolve) => redis!.close(() => resolve()));
  if (judge) {
    judge.closeAllConnections();
    await new Promise<void>((resolve) => judge!.close(() => resolve()));
  }
  if (cleanupAllowed) {
    await database.project.deleteMany({
      where: { id: { in: projects }, owner: { email: { in: emails } } },
    });
    await database.user.deleteMany({ where: { email: { in: emails } } });
  }
  await database.$disconnect();
}
