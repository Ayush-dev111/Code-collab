import { getDatabase } from "@collab/db";
import {
  hasMinimumRole,
  runSchema,
  RUN_LEASE_MS,
  type RunInput,
} from "@collab/shared";
import { ApiError } from "./api";
import { requireRole } from "./permissions";
import { acquireRunLease } from "./run-limits";
import { spawn } from "node:child_process";
import {
  readSubmission,
  resultFields,
  submitCode,
  tryRunnerConfiguration,
  waitForSubmission,
} from "./judge0";
import { notifyRun } from "./run-notifications";
async function findRun(id: string) {
  return getDatabase().run.findUnique({
    where: { id },
    include: { user: { select: { name: true } } },
  });
}
function serializeRun(row: NonNullable<Awaited<ReturnType<typeof findRun>>>) {
  return runSchema.parse({
    ...row,
    userName: row.user.name,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  });
}
function failedFields(message: string) {
  return {
    status: "FAILED" as const,
    statusLabel: "Execution unavailable",
    stderr: message.slice(0, 1000),
    finishedAt: new Date(),
  };
}

async function requireCodeItem(projectId: string, itemId: string) {
  const item = await getDatabase().item.findFirst({
    where: { id: itemId, projectId, type: "CODE" },
  });
  if (!item)
    throw new ApiError(404, "NOT_FOUND", "This code file is unavailable.");
  return item;
}

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PISTON_LANGUAGE_MAP: Record<string, string> = {
  javascript: "javascript",
  python: "python",
  cpp: "c++",
  java: "java",
  c: "c",
  typescript: "typescript",
  csharp: "csharp",
  go: "go",
  rust: "rust",
  ruby: "ruby",
  php: "php",
  swift: "swift",
  kotlin: "kotlin",
};

interface PistonExecutionResult {
  stdout?: string;
  stderr?: string;
  output?: string;
  code?: number | null;
  signal?: string | null;
}

interface PistonResponse {
  language?: string;
  version?: string;
  run?: PistonExecutionResult;
  compile?: PistonExecutionResult;
  message?: string;
}

async function runViaPiston(input: RunInput) {
  const pistonLang = PISTON_LANGUAGE_MAP[input.language] || input.language;
  const startTime = Date.now();
  const response = await fetch("https://emkc.org/api/v2/piston/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      language: pistonLang,
      version: "*",
      files: [{ content: input.sourceCode }],
      stdin: input.stdin || "",
    }),
    signal: AbortSignal.timeout(25_000),
  });

  if (!response.ok) {
    throw new Error(`Piston API returned status ${response.status}`);
  }

  const data = (await response.json()) as PistonResponse;
  const durationMs = Date.now() - startTime;

  if (data.compile && data.compile.code != null && data.compile.code !== 0) {
    return {
      status: "FAILED" as const,
      statusLabel: "Compilation Error",
      judge0Status: 6,
      stdout: data.compile.stdout || null,
      stderr: data.compile.stderr || data.compile.output || null,
      compileOutput: data.compile.output || data.compile.stderr || null,
      exitCode: data.compile.code,
      durationMs,
      outputTruncated: false,
      finishedAt: new Date(),
    };
  }

  const runResult = data.run;
  const isSuccess = runResult?.code === 0;

  return {
    status: isSuccess ? ("FINISHED" as const) : ("FAILED" as const),
    statusLabel: isSuccess ? "Accepted" : "Runtime Error",
    judge0Status: isSuccess ? 3 : 11,
    stdout: runResult?.stdout || null,
    stderr: runResult?.stderr || runResult?.output || null,
    compileOutput: null,
    exitCode: runResult?.code ?? 0,
    durationMs,
    outputTruncated: false,
    finishedAt: new Date(),
  };
}

async function executeLocally(input: RunInput) {
  const startTime = Date.now();
  let cmd: string;
  let args: string[];
  let tempFilePath: string | null = null;

  if (input.language === "javascript") {
    cmd = process.execPath;
    args = ["-e", input.sourceCode];
  } else if (input.language === "python") {
    cmd = "python";
    args = ["-c", input.sourceCode];
  } else if (input.language === "java") {
    const tempDir = os.tmpdir();
    tempFilePath = path.join(
      tempDir,
      `Run_${Date.now()}_${Math.random().toString(36).slice(2)}.java`,
    );
    try {
      await fs.promises.writeFile(tempFilePath, input.sourceCode, "utf8");
    } catch (err) {
      return {
        status: "FAILED" as const,
        statusLabel: "Write error",
        judge0Status: 13,
        stdout: null,
        stderr: err instanceof Error ? err.message : "Failed to create source file.",
        compileOutput: null,
        exitCode: 1,
        durationMs: 0,
        outputTruncated: false,
        finishedAt: new Date(),
      };
    }
    cmd = "java";
    args = [tempFilePath];
  } else {
    return {
      status: "FAILED" as const,
      statusLabel: "Language unavailable",
      judge0Status: 13,
      stdout: null,
      stderr: `Running ${input.language} locally without Docker/Judge0 is not supported. Supported local languages are JavaScript, Python, and Java.`,
      compileOutput: null,
      exitCode: 1,
      durationMs: 0,
      outputTruncated: false,
      finishedAt: new Date(),
    };
  }

  return new Promise<{
    status: "FINISHED" | "FAILED";
    statusLabel: string;
    judge0Status: number;
    stdout: string | null;
    stderr: string | null;
    compileOutput: string | null;
    exitCode: number | null;
    durationMs: number;
    outputTruncated: boolean;
    finishedAt: Date;
  }>((resolve) => {
    let stdoutData = "";
    let stderrData = "";
    const proc = spawn(cmd, args, { timeout: 15_000 });

    if (input.stdin) {
      proc.stdin?.write(input.stdin);
      proc.stdin?.end();
    }

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutData += chunk.toString("utf8");
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      stderrData += chunk.toString("utf8");
    });

    const cleanup = () => {
      if (tempFilePath) {
        fs.promises.unlink(tempFilePath).catch(() => undefined);
      }
    };

    proc.on("error", (err) => {
      cleanup();
      resolve({
        status: "FAILED",
        statusLabel: "Execution error",
        judge0Status: 13,
        stdout: null,
        stderr: err.message,
        compileOutput: null,
        exitCode: 1,
        durationMs: Date.now() - startTime,
        outputTruncated: false,
        finishedAt: new Date(),
      });
    });

    proc.on("close", (code) => {
      cleanup();
      const durationMs = Date.now() - startTime;
      resolve({
        status: code === 0 ? "FINISHED" : "FAILED",
        statusLabel: code === 0 ? "Accepted" : "Runtime Error",
        judge0Status: code === 0 ? 3 : 11,
        stdout: stdoutData || null,
        stderr: stderrData || null,
        compileOutput: null,
        exitCode: code,
        durationMs,
        outputTruncated: false,
        finishedAt: new Date(),
      });
    });
  });
}

export async function executeRun(input: RunInput, requestHeaders: Headers) {
  const { session } = await requireRole(
    input.projectId,
    "EDITOR",
    requestHeaders,
  );
  const item = await requireCodeItem(input.projectId, input.itemId);
  if (item.language !== input.language)
    throw new ApiError(
      409,
      "LANGUAGE_CHANGED",
      "The file's language changed. Wait for it to sync before running.",
    );
  const configuration = tryRunnerConfiguration();
  const release = configuration
    ? await acquireRunLease(
        configuration,
        session.user.id,
        input.projectId,
        input.itemId,
      )
    : process.env.REDIS_URL
      ? await acquireRunLease(
          {
            REDIS_URL: process.env.REDIS_URL,
            JUDGE0_URL: "http://127.0.0.1:2358/",
            JUDGE0_AUTH_TOKEN: "01234567890123456789012345678901",
          },
          session.user.id,
          input.projectId,
          input.itemId,
        )
      : async () => undefined;
  try {
    const database = getDatabase();
    const created = await database.$transaction(async (transaction) => {
      // Per-file concurrency is guarded by Redis lease. Lock item row instead of whole project.
      await transaction.$queryRaw`SELECT id FROM item WHERE id = ${input.itemId} AND "projectId" = ${input.projectId} FOR UPDATE`;
      const [membership, currentSession, currentItem] = await Promise.all([
        transaction.projectMember.findUnique({
          where: {
            projectId_userId: {
              projectId: input.projectId,
              userId: session.user.id,
            },
          },
        }),
        transaction.session.findUnique({ where: { id: session.session.id } }),
        transaction.item.findFirst({
          where: { id: input.itemId, projectId: input.projectId, type: "CODE" },
        }),
      ]);
      if (
        !membership ||
        !hasMinimumRole(membership.role, "EDITOR") ||
        !currentSession ||
        currentSession.userId !== session.user.id ||
        currentSession.expiresAt.getTime() <= Date.now()
      )
        throw new ApiError(
          403,
          "FORBIDDEN",
          "You no longer have permission to run code.",
        );
      if (!currentItem)
        throw new ApiError(404, "NOT_FOUND", "This code file is unavailable.");
      if (currentItem.language !== input.language)
        throw new ApiError(
          409,
          "LANGUAGE_CHANGED",
          "The file's language changed. Wait for it to sync before running.",
        );
      return transaction.run.create({
        data: {
          itemId: input.itemId,
          userId: session.user.id,
          language: input.language,
          sourceCode: input.sourceCode,
          stdin: input.stdin,
          status: "RUNNING",
          statusLabel: "Running",
        },
      });
    });
    const started = await notifyRun({
      projectId: input.projectId,
      runId: created.id,
      event: "run:started",
    });
    let fields;
    try {
      if (configuration) {
        const signal = AbortSignal.timeout(30_000);
        const token = await submitCode(configuration, input, signal);
        const saved = await database.run.updateMany({
          where: { id: created.id, status: "RUNNING" },
          data: { judge0Token: token },
        });
        if (!saved.count)
          throw new ApiError(404, "NOT_FOUND", "This run is unavailable.");
        fields = resultFields(
          await waitForSubmission(configuration, token, signal),
        );
      } else {
        try {
          fields = await runViaPiston(input);
        } catch {
          fields = await executeLocally(input);
        }
      }
    } catch (error) {
      fields = failedFields(
        error instanceof ApiError
          ? error.message
          : "The execution service could not complete this run. Try again later.",
      );
    }
    await database.run.updateMany({
      where: { id: created.id, status: "RUNNING" },
      data: fields,
    });
    const finished = await notifyRun({
      projectId: input.projectId,
      runId: created.id,
      event: "run:finished",
    });
    const record = await findRun(created.id);
    if (!record)
      throw new ApiError(404, "NOT_FOUND", "This run is unavailable.");
    return {
      run: serializeRun(record),
      notificationPending: !started || !finished,
    };
  } finally {
    await release();
  }
}

// If a web process stops during a run, a later history read reconciles the
// persisted sandbox token. Reads never submit or rerun source code.
async function recoverInterruptedRuns(projectId: string, itemId: string) {
  const database = getDatabase();
  const stale = await database.run.findMany({
    where: {
      itemId,
      status: "RUNNING",
      createdAt: { lt: new Date(Date.now() - RUN_LEASE_MS) },
    },
    take: 5,
  });
  for (const row of stale) {
    let fields:
      ReturnType<typeof failedFields> | ReturnType<typeof resultFields> =
      failedFields(
        "This run was interrupted before its result was saved. Run the file again.",
      );
    try {
      if (row.judge0Token) {
        const runnerConfig = tryRunnerConfiguration();
        if (runnerConfig) {
          const result = await readSubmission(
            runnerConfig,
            row.judge0Token,
            AbortSignal.timeout(4000),
          );
          if (result.status.id > 2)
            fields = { ...fields, ...resultFields(result) };
        }
      }
    } catch {
      /* A missing runner cannot leave an interrupted run pending forever. */
    }
    const changed = await database.run.updateMany({
      where: { id: row.id, status: "RUNNING" },
      data: fields,
    });
    if (changed.count)
      await notifyRun({ projectId, runId: row.id, event: "run:finished" });
  }
}

export async function getRunHistory(
  projectId: string,
  itemId: string,
  before: string | undefined,
  requestHeaders: Headers,
) {
  await requireRole(projectId, "VIEWER", requestHeaders);
  await requireCodeItem(projectId, itemId);
  void recoverInterruptedRuns(projectId, itemId);
  const database = getDatabase();
  const cursor = before
    ? await database.run.findFirst({
        where: { id: before, itemId },
        select: { id: true, createdAt: true },
      })
    : null;
  if (before && !cursor)
    throw new ApiError(
      400,
      "INVALID_CURSOR",
      "Choose a run from this file's history.",
    );
  const rows = await database.run.findMany({
    where: {
      itemId,
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 21,
    include: { user: { select: { name: true } } },
  });
  return {
    runs: rows.slice(0, 20).map(serializeRun),
    nextCursor: rows.length > 20 ? rows[19]!.id : null,
  };
}
