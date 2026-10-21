import { cache } from "react";
import { headers } from "next/headers";
import { getDatabase } from "@/lib/db";
import {
  hasMinimumRole,
  projectIdSchema,
  roleSchema,
  type Role,
} from "@/lib/shared";
import { ApiError, parseInput } from "@/lib/api";
import { getAuth } from "@/lib/auth";

async function loadSession(requestHeaders: Headers) {
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session)
    throw new ApiError(401, "UNAUTHENTICATED", "Sign in to continue.");
  return session;
}

// Server components share one lookup per request; route handlers pass headers.
const sessionForRender = cache(async () => loadSession(await headers()));

export function requireSession(requestHeaders?: Headers) {
  return requestHeaders ? loadSession(requestHeaders) : sessionForRender();
}

const membershipFor = cache((projectId: string, userId: string) =>
  getDatabase().projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  }),
);

export async function requireRole(
  projectId: string,
  minRole: Role,
  requestHeaders?: Headers,
) {
  const id = parseInput(projectIdSchema, projectId);
  const minimum = parseInput(roleSchema, minRole);
  const session = await requireSession(requestHeaders);
  const membership = await membershipFor(id, session.user.id);
  if (!membership || !hasMinimumRole(membership.role, minimum)) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      "You do not have permission to access this project.",
    );
  }
  return { session, membership };
}
