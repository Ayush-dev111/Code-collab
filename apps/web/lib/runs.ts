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
import {
  readSubmission,
  resultFields,
  runnerConfiguration,
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
  const configuration = runnerConfiguration();
  const release = await acquireRunLease(
    configuration,
    session.user.id,
    input.projectId,
    input.itemId,
  );
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
