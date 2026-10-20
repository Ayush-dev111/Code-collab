import { randomUUID } from "node:crypto";
import { getDatabase } from "@collab/db";
import { consumeRateLimit } from "@collab/server";
import {
  authEnvironmentSchema,
  createInviteSchema,
  emptyInputSchema,
  inviteResponseSchema,
  projectParamsSchema,
} from "@collab/shared";
import {
  assertSameOrigin,
  jsonResponse,
  parseInput,
  parseQuery,
  readJson,
  withApiError,
} from "@/lib/api";
import { requireRole } from "@/lib/permissions";

export const runtime = "nodejs";
type Context = { params: Promise<{ projectId: string }> };

export function POST(request: Request, context: Context) {
  return withApiError(async () => {
    parseQuery(request, emptyInputSchema);
    assertSameOrigin(request);
    const { projectId } = parseInput(projectParamsSchema, await context.params);
    const { session } = await requireRole(projectId, "OWNER", request.headers);
    const input = await readJson(request, createInviteSchema);
    await consumeRateLimit("invite-create", session.user.id, projectId);
    const invite = await getDatabase().invite.create({
      data: {
        projectId,
        code: randomUUID(),
        role: input.role,
        expiresAt: new Date(
          Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000,
        ),
      },
    });
    const environment = authEnvironmentSchema.parse(process.env);
    return jsonResponse(
      inviteResponseSchema,
      {
        invite: {
          code: invite.code,
          role: invite.role,
          expiresAt: invite.expiresAt.toISOString(),
          url: new URL(
            `/invite/${invite.code}`,
            environment.BETTER_AUTH_URL,
          ).toString(),
        },
      },
      201,
    );
  });
}
