import { getDatabase } from "@collab/db";
import { consumeRateLimit } from "@collab/server";
import {
  emptyInputSchema,
  inviteParamsSchema,
  invitePreviewResponseSchema,
} from "@collab/shared";
import {
  ApiError,
  jsonResponse,
  parseInput,
  parseQuery,
  withApiError,
} from "@/lib/api";
import { requireSession } from "@/lib/permissions";

export const runtime = "nodejs";
type Context = { params: Promise<{ code: string }> };

export function GET(request: Request, context: Context) {
  return withApiError(async () => {
    parseQuery(request, emptyInputSchema);
    const { code } = parseInput(inviteParamsSchema, await context.params);
    const session = await requireSession(request.headers);
    await consumeRateLimit("invite-preview", session.user.id);
    const invite = await getDatabase().invite.findUnique({
      where: { code },
      include: { project: true },
    });
    // Possession of a valid, unexpired grant authorizes this limited preview only.
    if (!invite || invite.role === "OWNER")
      throw new ApiError(
        404,
        "INVITE_UNAVAILABLE",
        "This invitation is invalid.",
      );
    if (invite.expiresAt <= new Date())
      throw new ApiError(410, "INVITE_EXPIRED", "This invitation has expired.");
    const membership = await getDatabase().projectMember.findUnique({
      where: {
        projectId_userId: {
          projectId: invite.projectId,
          userId: session.user.id,
        },
      },
    });
    return jsonResponse(invitePreviewResponseSchema, {
      invite: {
        projectId: invite.projectId,
        projectName: invite.project.name,
        role: invite.role,
        expiresAt: invite.expiresAt.toISOString(),
        isMember: Boolean(membership),
      },
    });
  });
}
