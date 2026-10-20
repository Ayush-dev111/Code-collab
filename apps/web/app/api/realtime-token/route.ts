import {
  emptyInputSchema,
  realtimeEnvironmentSchema,
  realtimeTokenRequestSchema,
  realtimeTokenResponseSchema,
} from "@collab/shared";
import { signRealtimeToken } from "@collab/shared/realtime-token";
import {
  assertSameOrigin,
  jsonResponse,
  parseQuery,
  readJson,
  withApiError,
} from "@/lib/api";
import { requireRole } from "@/lib/permissions";

export async function POST(request: Request): Promise<Response> {
  return withApiError(async () => {
    parseQuery(request, emptyInputSchema);
    assertSameOrigin(request);
    const input = await readJson(request, realtimeTokenRequestSchema);
    const { session, membership } = await requireRole(
      input.projectId,
      "VIEWER",
      request.headers,
    );
    const environment = realtimeEnvironmentSchema.parse(process.env);
    const { token, claims } = signRealtimeToken(
      {
        userId: session.user.id,
        sessionId: session.session.id,
        projectId: input.projectId,
        role: membership.role,
      },
      {
        secret: environment.REALTIME_TOKEN_SECRET,
        issuer: environment.BETTER_AUTH_URL,
      },
    );
    return jsonResponse(realtimeTokenResponseSchema, {
      token,
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      url: environment.REALTIME_HTTP_URL,
    });
  });
}
