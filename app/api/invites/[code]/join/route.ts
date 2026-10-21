import { getDatabase } from "@/lib/db";
import { consumeRateLimit } from "@/lib/rate-limit";
import {
  emptyInputSchema,
  inviteParamsSchema,
  joinInviteResponseSchema,
} from "@/lib/shared";
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
    const invite = await getDatabase().invite.findUnique({ where: { code } });
    if (!invite || invite.role === "OWNER")
      throw new ApiError(
        404,
        "INVITE_UNAVAILABLE",
        "This invitation is invalid.",
      );
    if (invite.expiresAt <= new Date())
      throw new ApiError(410, "INVITE_EXPIRED", "This invitation has expired.");
    consumeRateLimit("invite-join", session.user.id, invite.projectId);
    // Joining twice is harmless; an invitation never changes an existing role.
    const membership = await getDatabase().projectMember.upsert({
      where: {
        projectId_userId: {
          projectId: invite.projectId,
          userId: session.user.id,
        },
      },
      create: {
        projectId: invite.projectId,
        userId: session.user.id,
        role: invite.role,
      },
      update: {},
    });
    return jsonResponse(joinInviteResponseSchema, {
      projectId: membership.projectId,
      role: membership.role,
    });
  });
}
