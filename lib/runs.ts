import { getDatabase } from "@/lib/db";
import type { Run } from "@/lib/generated/prisma/client";
import { runSchema, RUN_LEASE_MS, type RunInput } from "@/lib/shared";
import { ApiError } from "./api";
import { requireRole } from "./permissions";
import { consumeRateLimit } from "./rate-limit";
import { emitToProject } from "./realtime-bus";
import { executeOnJudge0, judge0Configuration, runFields } from "./judge0";

const runInclude = { user: { select: { name: true } } } as const;
type RunRow = Run & { user: { name: string } };

function serializeRun(row: RunRow) {
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
    select: { language: true },
  });
  if (!item)
    throw new ApiError(404, "NOT_FOUND", "This code file is unavailable.");
  return item;
}

// Only one run per file at a time. Kept in memory: the app is one process.
const store = globalThis as typeof globalThis & {
  collabRunLeases?: Map<string, number>;
};
const leases = (store.collabRunLeases ??= new Map<string, number>());

function acquireFileLease(itemId: string) {
  const now = Date.now();
  const heldUntil = leases.get(itemId);
  if (heldUntil && heldUntil > now)
    throw new ApiError(
      409,
      "RUN_IN_PROGRESS",
      "A collaborator is already running this file. Wait for that run to finish.",
      Math.ceil((heldUntil - now) / 1000),
    );
  leases.set(itemId, now + RUN_LEASE_MS);
  return () => leases.delete(itemId);
}

function runEvent(projectId: string, itemId: string, runId: string) {
  return { projectId, itemId, runId, changedAt: new Date().toISOString() };
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
  judge0Configuration();
  consumeRateLimit("run", session.user.id, input.projectId);
  const release = acquireFileLease(input.itemId);
  try {
    const database = getDatabase();
    const created = await database.run.create({
      data: {
        itemId: input.itemId,
        userId: session.user.id,
        language: input.language,
        sourceCode: input.sourceCode,
        stdin: input.stdin,
        status: "RUNNING",
        statusLabel: "Running",
      },
      select: { id: true },
    });
    emitToProject(
      input.projectId,
      "run:started",
      runEvent(input.projectId, input.itemId, created.id),
    );
    let fields;
    try {
      const { token, result } = await executeOnJudge0(
        input,
        AbortSignal.timeout(45_000),
      );
      fields = { ...runFields(result), judge0Token: token };
    } catch (error) {
      fields = failedFields(
        error instanceof ApiError
          ? error.message
          : "The execution service could not complete this run. Try again later.",
      );
    }
    const finished = await database.run.update({
      where: { id: created.id },
      data: fields,
      include: runInclude,
    });
    emitToProject(
      input.projectId,
      "run:finished",
      runEvent(input.projectId, input.itemId, created.id),
    );
    return { run: serializeRun(finished) };
  } finally {
    release();
  }
}

// A run left RUNNING by a server restart is marked failed on the next read.
async function failInterruptedRuns(itemId: string) {
  await getDatabase().run.updateMany({
    where: {
      itemId,
      status: "RUNNING",
      createdAt: { lt: new Date(Date.now() - RUN_LEASE_MS) },
    },
    data: failedFields(
      "This run was interrupted before its result was saved. Run the file again.",
    ),
  });
}

export async function getRunHistory(
  projectId: string,
  itemId: string,
  before: string | undefined,
  requestHeaders: Headers,
) {
  await requireRole(projectId, "VIEWER", requestHeaders);
  await requireCodeItem(projectId, itemId);
  void failInterruptedRuns(itemId).catch(() => undefined);
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
    include: runInclude,
  });
  return {
    runs: rows.slice(0, 20).map(serializeRun),
    nextCursor: rows.length > 20 ? rows[19]!.id : null,
  };
}
