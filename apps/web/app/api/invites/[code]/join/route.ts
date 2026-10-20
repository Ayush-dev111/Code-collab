import { getDatabase } from "@collab/db";
import { consumeRateLimit } from "@collab/server";
import {
  emptyInputSchema,
  inviteParamsSchema,
  joinInviteResponseSchema,
} from "@collab/shared";
import {
  ApiError,
  assertSameOrigin,
  jsonResponse,
  parseInput,
  parseQuery,
  readJson,
  withApiError,
} from "@/lib/api";
import { requireSession } from "@/lib/permissions";

export const runtime = "nodejs";
type Context = { params: Promise<{ code: string }> };

export function POST(request: Request, context: Context) {
  return withApiError(async () => {
    parseQuery(request, emptyInputSchema);
    assertSameOrigin(request);
    const { code } = parseInput(inviteParamsSchema, await context.params);
    const session = await requireSession(request.headers);
    await readJson(request, emptyInputSchema);
    await consumeRateLimit("invite-join", session.user.id);
    const membership = await getDatabase().$transaction(async (transaction) => {
      const invite = await transaction.invite.findUnique({ where: { code } });
      if (!invite || invite.role === "OWNER")
        throw new ApiError(
          404,
          "INVITE_UNAVAILABLE",
          "This invitation is invalid.",
        );
      if (invite.expiresAt <= new Date())
        throw new ApiError(
          410,
          "INVITE_EXPIRED",
          "This invitation has expired.",
        );
      // Concurrent joins are harmless; an invitation never changes an existing role.
      const existing = await transaction.projectMember.findUnique({
        where: {
          projectId_userId: {
            projectId: invite.projectId,
            userId: session.user.id,
          },
        },
      });
      if (existing) return existing;
      await consumeRateLimit(
        "invite-join-project",
        session.user.id,
        invite.projectId,
      );
      await transaction.projectMember.createMany({
        data: [
          {
            projectId: invite.projectId,
            userId: session.user.id,
            role: invite.role,
          },
        ],
        skipDuplicates: true,
      });
      return transaction.projectMember.findUniqueOrThrow({
        where: {
          projectId_userId: {
            projectId: invite.projectId,
            userId: session.user.id,
          },
        },
      });
    });
    return jsonResponse(joinInviteResponseSchema, {
      projectId: membership.projectId,
      role: membership.role,
    });
  });
}
